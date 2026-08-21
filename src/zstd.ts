/**
 * zstd.ts — Zstandard 多帧容器处理（与 dsh-session-persistence-jsonl 平台格式兼容）
 *
 * 平台把会话日志存为「多帧连接容器」：header 一帧 + 每批事件一帧（append 追加新帧）。
 * 本模块移植平台的帧扫描算法（MIT 开源，node:zlib 内置 zstd），提供：
 *   scanFrames    —— 扫描完整帧边界（结构级，不解压）
 *   decompressAll —— 逐帧解压拼出完整文本
 *   compressFrame —— 压缩单帧（带 checksum，与平台一致）
 */
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'

/** Zstandard frame magic（小端 0xFD2FB528） */
const ZSTD_MAGIC = 4247762216

export interface FrameRange {
  /** 帧起始字节（含） */
  start: number
  /** 帧结束字节（不含） */
  end: number
}

/** 结构级扫描结果：完整帧 + 可选的未完成尾帧起点 */
export interface FrameScan {
  frames: FrameRange[]
  tornStart?: number
}

/**
 * 扫描 Zstandard 多帧流中的完整帧边界（不解压 block）。
 * 算法与平台 scanZstdFrames 一致：magic → descriptor → 剩余帧头 → 逐 block → checksum。
 */
export function scanFrames(buffer: Buffer): FrameScan {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt zstd session log: invalid frame magic at byte ' + offset)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error('corrupt zstd session log: reserved frame-header bit at byte ' + (offset - 1))
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error('corrupt zstd session log: reserved block type at byte ' + (offset - 3))
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 逐帧解压，拼出完整明文。
 * 任一完整帧解压失败 → 抛出（数据已损坏，不应继续）。
 */
export function decompressAll(buffer: Buffer): string {
  const { frames, tornStart } = scanFrames(buffer)
  const parts: string[] = []
  for (const frame of frames) {
    const seg = buffer.subarray(frame.start, frame.end)
    parts.push(zstdDecompressSync(seg).toString('utf8'))
  }
  if (tornStart !== undefined && tornStart < buffer.length) {
    // 未完成尾帧：不参与（平台读取同样忽略之）
  }
  return parts.join('')
}

/** 压缩单帧（带 content checksum，与平台 compressZstdFrame 一致） */
export function compressFrame(input: Buffer): Buffer {
  return zstdCompressSync(input, {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** 把文本压成平台同款的两帧布局：header 帧 + body 帧 */
export function compressLog(headerLine: string, bodyText: string): Buffer {
  const headerFrame = compressFrame(Buffer.from(headerLine + '\n', 'utf8'))
  const bodyFrame = bodyText.length > 0
    ? compressFrame(Buffer.from(bodyText.endsWith('\n') ? bodyText : bodyText + '\n', 'utf8'))
    : Buffer.alloc(0)
  return Buffer.concat([headerFrame, bodyFrame])
}
