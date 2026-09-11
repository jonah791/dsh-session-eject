/**
 * core.ts — 会话删帧核心：定位、读取、按 step 边界删除、seq rebase、重写、清理派生缓存
 *
 * 会话 = 一个 session.jsonl.zstd（zstd 多帧容器：header 帧 + 每批事件一帧）。
 * 平台加载器只扫描完整 JSONL 记录并容忍 torn tail，因此物理重写是安全的。
 *
 * **seq rebase（v0.2 核心改进）**：
 * 平台的 `seq = log.length` 连续性契约要求每个事件的 seq 等于其在展开数组中的位置。
 * 删帧保留前半部分行，其 seq 从 0 连续到 N。但如果删帧后旧持久化 writer 追加了新事件
 * （以 'a' 模式打开的 fd 在 rename 后仍有效，或 process.exit 前异步缓冲 flush），
 * 这些新事件的 seq 基于删除前的 log.length（N + diff），与保留行不连续 → 加载器
 * 在遇到 gap 时截断会话，丢失后续内容。
 *
 * seq rebase 解决方案：重写时把保留行的 seq 从 0 重编号。这样即使旧 writer 追加了
 * 旧 seq 的事件，加载器在 gap 处截断（保留 0..N 连续部分），后续旧事件被当作 torn
 * tail 忽略——会话不被破坏。
 *
 * 需要重编的字段：
 * - 普通行：obj.seq
 * - chunk-rows 行（text-chunks/reasoning-chunks/tool-call-chunks）：obj.seq0
 * - surface 事件（带 surfaceOp）：surfaceOp.start / surfaceOp.end（replace 类型）
 * - surface 事件（带 sourceEventSeqs）：数组中每个 seq
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { scanFrames, decompressAll, compressLog } from './zstd.ts'

/** chunk-rows 存储行类型 */
const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

export interface SessionRow {
  /** 原始行文本（不含换行） */
  line: string
  /** 行序列号：普通行用 seq，存储行（chunk run）用 seq0 */
  seq: number
  /** 行类型 */
  type: string
  /** 是否 chunk-rows 存储行 */
  isChunkRow: boolean
  /** chunk-rows 行展开后的子事件数（普通行为 1） */
  expandedCount: number
  /** 展开后的首个 seq（= seq 或 seq0） */
  firstExpandedSeq: number
  /** 展开后的末尾 seq（firstExpandedSeq + expandedCount - 1） */
  lastExpandedSeq: number
  /** 原始解析对象（原样保留用） */
  obj: Record<string, unknown>
}

export interface ParsedLog {
  headerLine: string
  rows: SessionRow[]
  /** 所有 step/start 行的 seq（升序，基于展开后的事件 seq） */
  stepStarts: number[]
  /** 展开后的总事件数 */
  totalExpandedEvents: number
}

export interface EjectResult {
  ok: boolean
  sessionId: string
  file: string
  /** 保留到该 seq 之前（boundarySeq 起删除） */
  boundarySeq: number
  /** 保留的最大展开 seq（rebase 后 = 保留事件数 - 1） */
  lastKeptSeq: number
  keptRows: number
  removedRows: number
  /** 被删区间覆盖的 step 数 */
  removedSteps: number
  /** 删除前的 step 总数 */
  totalSteps: number
  /** 是否执行了 seq rebase */
  rebased: boolean
  needRestart: boolean
  note?: string
}

/** DSH_HOME（与平台约定一致） */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 会话根目录 */
export function sessionsRoot(): string {
  return process.env.DSH_SESSIONS_ROOT ?? join(dshHome(), 'sessions')
}

/**
 * 获取 chunk-rows 行的子事件成员数组。
 * - tool-call-chunks: data.args
 * - text-chunks / reasoning-chunks: data.texts
 */
function getChunkMembers(obj: Record<string, unknown>): unknown[] {
  const data = obj['data']
  if (typeof data !== 'object' || data === null) return []
  const d = data as Record<string, unknown>
  if (obj['type'] === 'tool-call-chunks') {
    return Array.isArray(d['args']) ? d['args'] as unknown[] : []
  }
  return Array.isArray(d['texts']) ? d['texts'] as unknown[] : []
}

/**
 * 解析一行 JSON 为 SessionRow；解析失败返回 null（防御性跳过，但仍保留原行）。
 */
function parseRow(line: string): SessionRow | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    if (typeof obj !== 'object' || obj === null) return null
    const type = typeof obj['type'] === 'string' ? obj['type'] : 'unknown'
    const isChunkRow = CHUNK_ROW_TYPES.has(type)
    const seq = typeof obj['seq'] === 'number' ? obj['seq']
      : typeof obj['seq0'] === 'number' ? obj['seq0']
      : Number.NaN
    const expandedCount = isChunkRow ? getChunkMembers(obj).length : 1
    const firstExpandedSeq = seq
    const lastExpandedSeq = seq + expandedCount - 1
    return { line, seq, type, isChunkRow, expandedCount, firstExpandedSeq, lastExpandedSeq, obj }
  } catch {
    return null
  }
}

/** 读取一帧（第一个完整帧）并解析 header 行，返回 { headerLine, id } 或 null */
export function readHeaderInfo(file: string): { headerLine: string; id: string } | null {
  if (!existsSync(file)) return null
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  if (buf.length === 0) return null
  const { frames } = scanFrames(buf)
  if (frames.length === 0) return null
  const first = buf.subarray(frames[0]!.start, frames[0]!.end)
  try {
    const text = zstdDecompressSync(first).toString('utf8')
    const headerLine = text.split('\n', 1)[0]!
    const obj = JSON.parse(headerLine) as Record<string, unknown>
    if (obj && obj['type'] === 'session' && typeof obj['id'] === 'string') {
      return { headerLine, id: obj['id'] }
    }
    return null
  } catch {
    return null
  }
}

/** 递归寻找所有名为 session.jsonl.zstd 的会话文件 */
function collectSessionFiles(root: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSessionFiles(full, depth + 1))
    } else if (entry.isFile() && entry.name === 'session.jsonl.zstd') {
      out.push(full)
    }
  }
  return out
}

/** 定位会话文件：优先精确 sessionId；缺省取 header 有效且 mtime 最新的会话 */
export function locateSessionFile(root: string, sessionId?: string): { file: string; sessionId: string } | null {
  const files = collectSessionFiles(root)
  if (files.length === 0) return null
  let best: { file: string; id: string; mtime: number } | null = null
  for (const file of files) {
    const info = readHeaderInfo(file)
    if (!info) continue
    const mtime = statSync(file).mtimeMs
    if (sessionId !== undefined && info.id === sessionId) {
      return { file, sessionId: info.id }
    }
    if (!best || mtime > best.mtime) best = { file, id: info.id, mtime }
  }
  if (sessionId !== undefined) return null
  return best ? { file: best.file, sessionId: best.id } : null
}

/** 读取并解析整个日志（header + 所有行） */
export function parseLog(file: string): ParsedLog | null {
  if (!existsSync(file)) return null
  const buf = readFileSync(file)
  const text = decompressAll(buf)
  const lines = text.split('\n')
  const headerLine = lines[0]
  if (!headerLine) return null
  const rows: SessionRow[] = []
  const stepStarts: number[] = []
  let totalExpandedEvents = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const row = parseRow(line)
    if (!row) continue
    rows.push(row)
    if (row.type === 'step/start' && Number.isFinite(row.seq)) stepStarts.push(row.seq)
    totalExpandedEvents += row.expandedCount
  }
  return { headerLine, rows, stepStarts, totalExpandedEvents }
}

/**
 * 计算删除边界：删最近 N 帧（step 粒度）→ 保留到「倒数第 N 个 step/start」之前。
 * 帧数不足时返回 null（调用方决定行为）。
 */
export function computeBoundary(parsed: ParsedLog, frames: number): { boundarySeq: number; removedSteps: number } | null {
  const starts = parsed.stepStarts
  if (starts.length === 0) return null
  const n = Math.min(frames, starts.length)
  const boundary = starts[starts.length - n]!
  return { boundarySeq: boundary, removedSteps: n }
}

/**
 * 对一个保留行做 seq rebase：把旧 seq 映射到新 seq（从 0 连续递增）。
 * 修改 obj 的 seq/seq0/surfaceOp/sourceEventSeqs 字段，返回重编后的 JSON 行文本。
 */
function rebaseRow(row: SessionRow, seqMap: Map<number, number>): string {
  const obj = row.obj
  const oldSeq = row.seq

  // 普通行：重编 seq
  if (!row.isChunkRow) {
    const newSeq = seqMap.get(oldSeq)
    if (newSeq !== undefined && newSeq !== oldSeq) {
      obj['seq'] = newSeq
    }
  } else {
    // chunk-rows 行：重编 seq0
    const newSeq0 = seqMap.get(oldSeq)
    if (newSeq0 !== undefined && newSeq0 !== oldSeq) {
      obj['seq0'] = newSeq0
    }
  }

  // surface 事件：重编 surfaceOp 和 sourceEventSeqs
  if (typeof obj['surfaceOp'] === 'object' && obj['surfaceOp'] !== null) {
    const op = obj['surfaceOp'] as Record<string, unknown>
    if (op['op'] === 'replace') {
      // V3 canonical envelope（2026-09-10 修复）：现行键名是 startSeq/endSeq；旧
      // v2 形态 start/end 仅需兼容历史文件——只认旧键名会漏改 V3 日志的 replace 引用
      const remap = (key: string): void => {
        const value = op[key]
        if (typeof value !== 'number') return
        const mapped = seqMap.get(value)
        if (mapped !== undefined) op[key] = mapped
      }
      remap('startSeq')
      remap('endSeq')
      remap('start')
      remap('end')
    }
  }

  if (Array.isArray(obj['sourceEventSeqs'])) {
    const srcSeqs = obj['sourceEventSeqs'] as number[]
    obj['sourceEventSeqs'] = srcSeqs.map(s => seqMap.get(s) ?? s)
  }

  return JSON.stringify(obj)
}

/**
 * 执行删帧 + seq rebase：
 * - 重写文件：header + 保留行（尾部帧删除），seq 从 0 重编
 * - **修复已有 seq gap**：如果文件已有 seq 断档（旧 writer 追加的旧 seq 事件），
 *   gap 后的行也保留并 rebase，使整个文件从 0 连续递增
 * - 平台同款 zstd 两帧布局，原子替换（tmp + rename）
 * - 清理派生缓存：session_projcache.json 中该会话条目
 * - dryRun 只计算不落盘
 */
export function ejectRecent(root: string, sessionId: string, frames: number, opts: { dryRun?: boolean; projcache?: boolean } = {}): EjectResult {
  const located = locateSessionFile(root, sessionId)
  if (!located) {
    throw new Error('会话文件不存在: ' + sessionId)
  }
  const { file } = located
  const parsed = parseLog(file)
  if (!parsed) throw new Error('无法解析会话日志: ' + file)
  const boundary = computeBoundary(parsed, frames)
  if (!boundary) throw new Error('会话中没有 step/start 事件，无法界定帧边界: ' + file)

  // 按「展开后 seq 是否 >= boundarySeq」决定删除：保留前面的行（可能含已有 gap），删除尾部帧
  const kept: SessionRow[] = []
  let removedRows = 0
  for (const row of parsed.rows) {
    if (Number.isFinite(row.firstExpandedSeq) && row.firstExpandedSeq >= boundary.boundarySeq) {
      removedRows++
    } else {
      kept.push(row)
    }
  }

  // 构建 seq 映射：旧 seq → 新 seq（从 0 连续递增，跨越已有 gap）
  // 保留行的 seq 可能不连续（有 gap），rebase 使其从 0 连续
  const seqMap = new Map<number, number>()
  let newSeq = 0
  let gapDetected = false
  for (const row of kept) {
    if (!Number.isFinite(row.firstExpandedSeq)) continue
    // 检测 gap：如果 row.firstExpandedSeq !== newSeq，说明有 gap
    if (row.firstExpandedSeq !== newSeq) gapDetected = true
    seqMap.set(row.firstExpandedSeq, newSeq)
    if (row.isChunkRow) {
      for (let k = 1; k < row.expandedCount; k++) {
        seqMap.set(row.firstExpandedSeq + k, newSeq + k)
      }
      newSeq += row.expandedCount
    } else {
      newSeq += 1
    }
  }
  const lastKeptSeq = newSeq - 1
  const rebased = gapDetected || (newSeq > 0 && kept.some(r => seqMap.get(r.firstExpandedSeq) !== r.firstExpandedSeq))

  // 重编行文本
  const keptLines: string[] = []
  for (const row of kept) {
    keptLines.push(rebaseRow(row, seqMap))
  }

  const body = keptLines.join('\n') + (keptLines.length > 0 ? '\n' : '')

  if (!opts.dryRun) {
    // 原子写：同目录临时文件 + rename（目标被持久化 writer 共享打开时 rename 可能失败，
    // 降级为复制覆盖——内容一致，只是弱原子性）
    const tmp = file + '.eject-tmp'
    const packed = compressLog(parsed.headerLine, body)
    writeFileSync(tmp, packed)
    try {
      renameSync(tmp, file)
    } catch {
      copyFileSync(tmp, file)
      rmSync(tmp, { force: true })
    }
    if (opts.projcache !== false) cleanProjectionCache(sessionId)
  }

  return {
    ok: true,
    sessionId,
    file,
    boundarySeq: boundary.boundarySeq,
    lastKeptSeq,
    keptRows: kept.length,
    removedRows,
    removedSteps: boundary.removedSteps,
    totalSteps: parsed.stepStarts.length,
    rebased,
    needRestart: true,
  }
}

/** 清理投影缓存中指定会话的条目（增量投影依赖 seq 版本，删帧后必须同步） */
export function cleanProjectionCache(sessionId: string): boolean {
  const file = join(dshHome(), 'storages', 'session_projcache.json')
  if (!existsSync(file)) return false
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      tables?: { sessions?: Record<string, unknown> }
    }
    const sessions = data?.tables?.sessions
    if (!sessions || !(sessionId in sessions)) return false
    delete sessions[sessionId]
    const tmp = file + '.eject-tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 检测会话日志中的 seq gap（不修改文件）。
 * 返回 gap 信息：gap 前的最后 seq、gap 后的第一个 seq、gap 后的事件类型列表。
 * 用于 session_eject_status 工具的修复诊断。
 */
export function detectSeqGaps(file: string): { hasGap: boolean; gapBeforeSeq: number; gapAfterSeq: number; postGapTypes: string[]; hasTurnEndPostGap: boolean } | null {
  const parsed = parseLog(file)
  if (!parsed) return null
  let expectedSeq = 0
  let gapBeforeSeq = -1
  let gapAfterSeq = -1
  const postGapTypes: string[] = []
  let gapFound = false
  for (const row of parsed.rows) {
    if (!Number.isFinite(row.firstExpandedSeq)) continue
    if (!gapFound && row.firstExpandedSeq !== expectedSeq) {
      gapFound = true
      gapBeforeSeq = expectedSeq - 1
      gapAfterSeq = row.firstExpandedSeq
    }
    if (gapFound) postGapTypes.push(row.type)
    expectedSeq += row.expandedCount
  }
  return {
    hasGap: gapFound,
    gapBeforeSeq,
    gapAfterSeq,
    postGapTypes: [...new Set(postGapTypes)],
    hasTurnEndPostGap: postGapTypes.includes('turn/end'),
  }
}

/**
 * 修复会话日志的 seq gap（不删帧，只 rebase）。
 * 把所有行从 0 重编，使整个文件 seq 连续。
 * 用于修复已被旧 writer 追加导致断档的文件。
 */
export function repairSeqGaps(root: string, sessionId: string, opts: { dryRun?: boolean; projcache?: boolean } = {}): { ok: boolean; sessionId: string; file: string; gapFixed: boolean; lastSeq: number; totalRows: number; needRestart: boolean } {
  const located = locateSessionFile(root, sessionId)
  if (!located) throw new Error('会话文件不存在: ' + sessionId)
  const { file } = located
  const parsed = parseLog(file)
  if (!parsed) throw new Error('无法解析会话日志: ' + file)

  // 检测是否有 gap
  let expectedSeq = 0
  let gapDetected = false
  for (const row of parsed.rows) {
    if (!Number.isFinite(row.firstExpandedSeq)) continue
    if (row.firstExpandedSeq !== expectedSeq) gapDetected = true
    expectedSeq += row.expandedCount
  }

  // 构建 seq 映射：所有行从 0 重编
  const seqMap = new Map<number, number>()
  let newSeq = 0
  for (const row of parsed.rows) {
    if (!Number.isFinite(row.firstExpandedSeq)) continue
    seqMap.set(row.firstExpandedSeq, newSeq)
    if (row.isChunkRow) {
      for (let k = 1; k < row.expandedCount; k++) {
        seqMap.set(row.firstExpandedSeq + k, newSeq + k)
      }
      newSeq += row.expandedCount
    } else {
      newSeq += 1
    }
  }
  const lastSeq = newSeq - 1

  if (!gapDetected) {
    return { ok: true, sessionId, file, gapFixed: false, lastSeq, totalRows: parsed.rows.length, needRestart: false }
  }

  const rebasedLines = parsed.rows.map(row => rebaseRow(row, seqMap))
  const body = rebasedLines.join('\n') + (rebasedLines.length > 0 ? '\n' : '')

  if (!opts.dryRun) {
    const tmp = file + '.repair-tmp'
    const packed = compressLog(parsed.headerLine, body)
    writeFileSync(tmp, packed)
    try {
      renameSync(tmp, file)
    } catch {
      copyFileSync(tmp, file)
      rmSync(tmp, { force: true })
    }
    if (opts.projcache !== false) cleanProjectionCache(sessionId)
  }

  return { ok: true, sessionId, file, gapFixed: true, lastSeq, totalRows: parsed.rows.length, needRestart: true }
}

/**
 * 归一化文本用于短语匹配：只保留汉字/拉丁字母/数字，删除空白与全部标点符号。
 * 使「你好，我无法给到相关内容。」≡「你好我无法给到相关内容」≡「我无法给到相关内容」，
 * 兼容网关话术的前缀/标点/换行差异。
 */
export function normalizeForMatch(text: string): string {
  return text.replace(/[^\p{Script=Han}\p{Script=Latin}\p{N}]/gu, '')
}

/**
 * 判断文本（归一化后）是否包含任一触发短语（归一化后）。
 * 用于内容通道：检测模型输出流中出现的「审核拒绝话术」。
 */
export function containsAnyPhrase(text: string, phrases: string[]): boolean {
  const norm = normalizeForMatch(text)
  return phrases.some((p) => p.length > 0 && norm.includes(normalizeForMatch(p)))
}
