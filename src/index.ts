/**
 * dsh-session-eject — 会话应急删帧插件
 *
 * 背景（2026-08-18 主人需求）：模型走第三方服务有外部审核，会话上下文一旦混入
 * 敏感内容，整个会话将因审核无法使用。本插件把「近几帧」从会话事件流中物理删除，
 * 重启后上下文即不含被删内容。
 *
 * 两个触发面：
 *  1. 工具面（爱丽丝/主人可调）：session_eject_recent —— 手动删最近 N 个 step 帧；
 *     session_eject_status —— 删前诊断（当前会话/帧数/事件规模）。
 *  2. 自动面（llm/stream 瀑布内）：
 *     a. 内容通道（主触发，2026-08-19 主人定调）：外部审核中断**不会报错**，模型只会
 *        正常输出「你好，我无法给到相关内容。」这类拒绝话术 → 拼接流式输出文本，
 *        命中 triggerPhrases 且命中后几乎不再有输出（tailChars ≤ phraseTailCharsMax）
 *        即判定为审核拒绝 → 自动删最近 autoFrames 帧 + 清派生缓存 +
 *        process.exit(0)（web 由 watch 守护拉起，重载后上下文干净）。
 *     b. 错误通道（兜底）：监听 provider 审核类错误（content policy / moderation /
 *        敏感 等特征词）→ 同样自动删帧并重启。
 *
 * 技术要点（实测验证）：
 *  - 会话 = session.jsonl.zstd（zstd 多帧容器：header 帧 + 每批事件一帧）
 *  - 平台无删事件 API，但加载器只扫完整记录并容忍 torn tail，物理重写安全
 *  - 重写保持原始行（含 packChunks 存储行），布局不变字节兼容
 *  - 派生缓存 session_projcache.json 按会话+seq 键控，删帧必须同步清理
 *  - **seq rebase（v0.2）**：重写时把保留行 seq 从 0 重编，确保加载器
 *    `seq = log.length` 连续性契约满足。即使旧持久化 writer 追加了旧 seq 事件，
 *    加载器在 gap 处截断（保留 0..N 连续部分），后续旧事件被当作 torn tail 忽略。
 *    需要重编：seq/seq0（普通行/chunk-rows）、surfaceOp.start/end（replace）、sourceEventSeqs。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionsRoot, dshHome, locateSessionFile, parseLog, computeBoundary, ejectRecent, containsAnyPhrase, detectSeqGaps, repairSeqGaps } from './core.ts'

export const name = 'agent-session-eject'
export const inject = ['tools'] as const

export interface Config {
  /** 插件总开关 */
  enabled: boolean
  /** 自动触发：监听模型输出内容（审核拒绝话术）/ provider 审核错误，自动删帧并重启 */
  autoTrigger: boolean
  /** 自动触发时删除的帧数（step 粒度） */
  autoFrames: number
  /** 内容通道触发短语（模型输出中出现即候选；归一化匹配，覆盖标点/前缀差异） */
  triggerPhrases: string[]
  /** 命中短语后允许的后续输出字符数上限（防正常引用误触发；审核拒绝时后续≈0） */
  phraseTailCharsMax: number
  /** 审核错误特征词（错误通道兜底；命中任一即触发；大小写不敏感） */
  policyKeywords: string[]
  /** 会话存储根目录（缺省 DSH_HOME/sessions） */
  sessionsRoot?: string
  /** 连续自动触发的最大次数（防误触发循环；超过后暂停自动面） */
  maxAutoTriggers: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  autoTrigger: z.boolean().default(true),
  autoFrames: z.number().step(1).min(1).max(50).default(2),
  triggerPhrases: z.array(z.string()).default([
    '你好，我无法给到相关内容。',
    '我无法给到相关内容',
  ]),
  phraseTailCharsMax: z.number().step(1).min(0).max(10000).default(200),
  policyKeywords: z.array(z.string()).default([
    'content policy', 'policy violation', 'moderation', 'inappropriate content',
    'sensitive content', 'banned', 'refused', 'blocked by', 'safety filter',
    'does not comply', 'flagging system', 'harmful content', 'explicit content',
    '审核', '违规', '敏感内容', '不当内容', '内容策略', '被拒绝', '不适当',
  ]),
  sessionsRoot: z.string().required(false),
  maxAutoTriggers: z.number().step(1).min(1).max(20).default(3),
})

/** 自动触发标记文件（防循环） */
function markerFile(): string {
  return join(dshHome(), 'session-eject-marker.json')
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-session-eject')
  const root = () => config.sessionsRoot ?? sessionsRoot()

  function loadMarker(): { count: number; lastAt: number } {
    try {
      const raw = readFileSync(markerFile(), 'utf8')
      const m = JSON.parse(raw) as { count?: number; lastAt?: number }
      return { count: m.count ?? 0, lastAt: m.lastAt ?? 0 }
    } catch {
      return { count: 0, lastAt: 0 }
    }
  }

  function saveMarker(count: number): void {
    try {
      writeFileSync(markerFile(), JSON.stringify({ count, lastAt: Date.now() }))
    } catch {
      /* 标记写失败不阻断主流程 */
    }
  }

  /** 判断错误消息是否命中审核特征词 */
  function matchesPolicy(message: string): boolean {
    const lower = message.toLowerCase()
    return config.policyKeywords.some((k) => k.length > 0 && lower.includes(k.toLowerCase()))
  }

  /** 手动删帧（工具入口） */
  function doEject(sessionId: string | undefined, frames: number, dryRun: boolean): ReturnType<typeof ejectRecent> {
    const located = locateSessionFile(root(), sessionId)
    if (!located) {
      throw new Error('找不到会话文件' + (sessionId ? '（' + sessionId + '）' : '（最新会话）'))
    }
    const parsed = parseLog(located.file)
    if (!parsed) throw new Error('无法解析会话日志: ' + located.file)
    const boundary = computeBoundary(parsed, frames)
    if (!boundary) {
      throw new Error('会话中没有 step 边界（step/start 事件），无法界定帧：' + located.file)
    }
    return ejectRecent(root(), located.sessionId, frames, { dryRun })
  }

  // ---------- 工具面 ----------

  ctx.tools.register(defineTool({
    name: 'session_eject_recent',
    description: '删除会话最近 N 帧（DSH step 粒度，一帧=一次完整思考+工具调用链）并从上下文剔除。用于第三方服务审核场景：会话混入敏感内容后调用，物理删除事件（重写 session.jsonl.zstd）+ 清理派生缓存；执行后需重启 web 生效（爱丽丝随后调 daemon_restart）。缺省操作当前最新会话，可指定任意 sessionId。',
    parameters: {
      frames: { type: 'number', description: '删除的帧数（最近 N 个 step；含其全部 chunk/工具调用事件）', required: true },
      sessionId: { type: 'string', description: '目标会话 id（缺省=最新活跃会话）' },
      dryRun: { type: 'boolean', description: 'true=只计算不动文件（预览将被删除的帧数）' },
      reason: { type: 'string', description: '删除原因（决策留痕，建议填写）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          file: { type: 'string' },
          boundarySeq: { type: 'number' },
          lastKeptSeq: { type: 'number' },
          keptRows: { type: 'number' },
          removedRows: { type: 'number' },
          removedSteps: { type: 'number' },
          totalSteps: { type: 'number' },
          rebased: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          needRestart: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: (v.dryRun ? '【预览】' : '已删除') + ' ' + v.removedSteps + '/' + v.totalSteps + ' 帧 (' + v.removedRows + ' 事件行) session=' + v.sessionId + (v.rebased ? ' seq rebased→0..' + v.lastKeptSeq : '') + (v.needRestart && !v.dryRun ? ' → 请重启 web 生效' : ''),
      }],
    },
    async execute(args: { frames: number; sessionId?: string; dryRun?: boolean; reason?: string }) {
      if (!config.enabled) return { ok: false, note: '插件已禁用' }
      const frames = Math.max(1, Math.floor(args.frames))
      const dryRun = args.dryRun === true
      logger.info('eject frames=' + frames + ' session=' + (args.sessionId ?? 'latest') + ' dryRun=' + dryRun + (args.reason ? ' reason=' + args.reason : ''))
      try {
        const r = doEject(args.sessionId, frames, dryRun)
        return { ok: r.ok, sessionId: r.sessionId, file: r.file, boundarySeq: r.boundarySeq, lastKeptSeq: r.lastKeptSeq, keptRows: r.keptRows, removedRows: r.removedRows, removedSteps: r.removedSteps, totalSteps: r.totalSteps, rebased: r.rebased, dryRun, needRestart: r.needRestart }
      } catch (err) {
        logger.error('eject failed: ' + String(err))
        return { ok: false, note: String(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_eject_status',
    description: '会话删帧诊断：查看最新/指定会话的文件、step 帧总数、事件行规模、自动触发状态。删帧前调用以确认目标与帧数。',
    parameters: {
      sessionId: { type: 'string', description: '目标会话 id（缺省=最新活跃会话）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          file: { type: 'string' },
          totalSteps: { type: 'number' },
          eventRows: { type: 'number' },
          totalEvents: { type: 'number' },
          hasSeqGap: { type: 'boolean' },
          gapBeforeSeq: { type: 'number' },
          gapAfterSeq: { type: 'number' },
          hasTurnEndPostGap: { type: 'boolean' },
          autoTrigger: { type: 'boolean' },
          autoFrames: { type: 'number' },
          triggerPhrases: { type: 'array', items: { type: 'string' } },
          phraseTailCharsMax: { type: 'number' },
          markerCount: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: 'session=' + v.sessionId + ' steps=' + v.totalSteps + ' rows=' + v.eventRows + ' events=' + v.totalEvents + (v.totalSteps > 0 ? ' （' + v.totalSteps + ' 帧）' : '') + (v.hasSeqGap ? ' ⚠ seq gap ' + v.gapBeforeSeq + '→' + v.gapAfterSeq + (v.hasTurnEndPostGap ? ' (turn/end post-gap→不可加载)' : ' (可截断恢复)') : ' ✓ seq ok') + ' auto=' + (v.autoTrigger ? 'on(' + v.autoFrames + '帧/短语' + (v.triggerPhrases ?? []).length + '条/tail≤' + v.phraseTailCharsMax + ')' : 'off'),
      }],
    },
    async execute(args: { sessionId?: string }) {
      try {
        const located = locateSessionFile(root(), args.sessionId)
        if (!located) return { ok: false, note: '找不到会话文件' + (args.sessionId ? '（' + args.sessionId + '）' : '') }
        const parsed = parseLog(located.file)
        const marker = loadMarker()
        const gap = detectSeqGaps(located.file)
        return {
          ok: true,
          sessionId: located.sessionId,
          file: located.file,
          totalSteps: parsed?.stepStarts.length ?? 0,
          eventRows: parsed?.rows.length ?? 0,
          totalEvents: parsed?.totalExpandedEvents ?? 0,
          hasSeqGap: gap?.hasGap ?? false,
          gapBeforeSeq: gap?.gapBeforeSeq ?? -1,
          gapAfterSeq: gap?.gapAfterSeq ?? -1,
          hasTurnEndPostGap: gap?.hasTurnEndPostGap ?? false,
          autoTrigger: config.autoTrigger,
          autoFrames: config.autoFrames,
          triggerPhrases: config.triggerPhrases,
          phraseTailCharsMax: config.phraseTailCharsMax,
          markerCount: marker.count,
        }
      } catch (err) {
        return { ok: false, note: String(err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_eject_repair',
    description: '修复会话日志的 seq 断档（不删帧，只 rebase）。当 session_eject_status 报告 hasSeqGap=true 时调用：把所有行 seq 从 0 重编，使整个文件连续。修复后需重启 web 生效。',
    parameters: {
      sessionId: { type: 'string', description: '目标会话 id（缺省=最新活跃会话）' },
      dryRun: { type: 'boolean', description: 'true=只计算不动文件（预览修复效果）' },
      reason: { type: 'string', description: '修复原因（决策留痕，建议填写）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          file: { type: 'string' },
          gapFixed: { type: 'boolean' },
          lastSeq: { type: 'number' },
          totalRows: { type: 'number' },
          dryRun: { type: 'boolean' },
          needRestart: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.gapFixed ? (v.dryRun ? '【预览】' : '已修复') + ' seq gap → 0..' + v.lastSeq + ' (' + v.totalRows + ' 行) session=' + v.sessionId + (v.needRestart && !v.dryRun ? ' → 请重启 web 生效' : '') : '无 seq gap，无需修复 session=' + v.sessionId,
      }],
    },
    async execute(args: { sessionId?: string; dryRun?: boolean; reason?: string }) {
      if (!config.enabled) return { ok: false, note: '插件已禁用' }
      const dryRun = args.dryRun === true
      logger.info('repair session=' + (args.sessionId ?? 'latest') + ' dryRun=' + dryRun + (args.reason ? ' reason=' + args.reason : ''))
      try {
        const r = repairSeqGaps(root(), args.sessionId ?? '', { dryRun })
        return { ok: r.ok, sessionId: r.sessionId, file: r.file, gapFixed: r.gapFixed, lastSeq: r.lastSeq, totalRows: r.totalRows, dryRun, needRestart: r.needRestart }
      } catch (err) {
        logger.error('repair failed: ' + String(err))
        return { ok: false, note: String(err) }
      }
    },
  }))

  // ---------- 自动触发面 ----------

  /** 共用触发动作：删帧 + 记 marker + 延迟退出触发守护重启 */
  function doAutoEject(reason: string, detail: string): void {
    const marker = loadMarker()
    if (marker.count >= config.maxAutoTriggers && Date.now() - marker.lastAt < 10 * 60 * 1000) {
      logger.warn('auto-trigger suppressed（连续触发已达上限 ' + marker.count + ' 次）: ' + detail)
      return
    }
    logger.warn('[' + reason + '] 自动删帧 ' + config.autoFrames + ' 帧: ' + detail)
    try {
      const r = doEject(undefined, config.autoFrames, false)
      saveMarker(marker.count + 1)
      logger.warn('auto-eject 完成 boundarySeq=' + r.boundarySeq + ' removed=' + r.removedRows + ' rows rebased=' + r.rebased + ' lastKeptSeq=' + r.lastKeptSeq + ' → 正常退出以触发守护重启')
      // 延迟退出，让日志尽量落盘 + 给持久化 writer 时间完成在途写入
      // seq rebase 确保即使 writer 追加旧 seq 事件，加载器也会在 gap 处截断保护会话
      setTimeout(() => process.exit(0), 1000)
    } catch (ejectErr) {
      logger.error('auto-eject 失败: ' + String(ejectErr) + ' → 不退出，保留现场')
    }
  }

  if (config.autoTrigger) {
    ctx.on('llm/stream', (_options, next) => {
      const stream = next()
      return (async function* () {
        // —— 内容通道（主触发）：外部审核不报错，模型只输出拒绝话术 ——
        const phrases = config.triggerPhrases.filter((p) => p.length > 0)
        const longest = phrases.reduce((m, p) => Math.max(m, p.length), 0)
        // 滚动缓冲上限：最长短语 4 倍（下限 128），防 delta 分片拆散短语
        const MAX_BUF = Math.max(128, longest * 4)
        let buf = ''
        let phraseHit = false
        // 命中后继续输出的字符数（审核拒绝时后续≈0；正常引用会继续输出→不触发）
        let tailChars = 0
        try {
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') {
              buf = (buf + chunk.text).slice(-MAX_BUF)
              if (!phraseHit && phrases.length > 0 && containsAnyPhrase(buf, phrases)) {
                phraseHit = true
                logger.info('内容通道命中审核拒绝话术: ' + JSON.stringify(buf.slice(-Math.min(80, buf.length))))
              }
              if (phraseHit) tailChars += chunk.text.length
            } else if (chunk.type === 'block-end') {
              // 兜底：某些适配器可能直接给出完整文本块
              const blockText = (chunk.block as { text?: string } | undefined)?.text
              if (blockText && !phraseHit && phrases.length > 0 && containsAnyPhrase(blockText, phrases)) {
                phraseHit = true
                logger.info('内容通道命中审核拒绝话术（block-end）: ' + JSON.stringify(blockText.slice(0, 80)))
              }
            }
            yield chunk
          }
          // 流正常结束：内容通道命中 → 自动删帧（后续文本量在阈值内才判定为审核拒绝）
          if (phraseHit && tailChars <= config.phraseTailCharsMax) {
            doAutoEject('content-phrase', '模型输出含拒绝话术，命中后后续输出 ' + tailChars + ' 字符（阈值 ' + config.phraseTailCharsMax + '）')
          } else if (phraseHit) {
            logger.info('内容通道命中但后续输出 ' + tailChars + ' 字符（> ' + config.phraseTailCharsMax + '），判定为正常引用，不触发')
          }
        } catch (err) {
          // —— 错误通道（兜底）：provider 审核类错误 ——
          const message = err instanceof Error ? (err.message ?? '') + ' ' + String(err) : String(err)
          if (matchesPolicy(message)) {
            doAutoEject('policy-error', message.slice(0, 300))
          } else {
            logger.info('llm stream 错误（非审核特征，不触发）: ' + message.slice(0, 120))
          }
          throw err
        }
      })()
    })
  }

  ctx.effect(() => {
    const marker = loadMarker()
    const note = marker.count > 0 ? '（历史自动触发 ' + marker.count + ' 次）' : ''
    logger.info('ready auto=' + config.autoTrigger + ' frames=' + config.autoFrames + ' keywords=' + config.policyKeywords.length + note)
    return () => { /* 无清理 */ }
  })
}
