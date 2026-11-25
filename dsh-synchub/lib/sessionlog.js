/**
 * dsh-synchub · 会话日志物理层（只读）
 *
 * 为什么单独成文件：index.js 已 4200+ 行；而「apply 前判断本机日志是不是比 payload 更新」
 * 需要解压 zstd 多帧容器，逻辑独立、可单测。sessiondoctor.js 只读第一帧的 header，
 * 这里才做全量解码与 seq 连续性检查。
 *
 * 帧扫描算法照抄平台源码 @deepseek-ai/dsh-session-persistence-jsonl 的 scanZstdFrames
 * （不重造轮子，保证与宿主读取口径一致）。宿主读会话日志的硬约束有两条：
 *   ① 第一帧恰好一条 header 行（assertZstdHeaderFrame）；
 *   ② 事件按 seq 连续递增（released v2 decoder 的 seq gap 检查）。
 * 本模块只做「只读解码 + seq 连续性检查」，不写盘、不改格式、不猜内容。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/** zstd 帧魔数（小端读取 28 B5 2F FD 的结果，与平台源码一致）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 扫出所有结构完整的 zstd 帧，不解压块内容。
 * 与平台 scanZstdFrames 同口径：遇到不完整的尾帧返回 tornStart，遇到结构错误抛错。
 * @param {Buffer} buffer 完整文件字节
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 解压一个会话日志的全部完整帧，拼成 JSONL 明文。
 * 只读：不解不成也不抛给调用方，返回 ok:false + 原因。
 * @param {string} abs 文件绝对路径
 * @returns {{ok:boolean, plaintext?:Buffer, frames?:number, error?:string}}
 */
export function decodeSessionLog(abs) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (error) {
    return { ok: false, error: `读不到文件：${error.message}` };
  }
  let scanned;
  try {
    scanned = scanZstdFrames(buf);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const parts = [];
  for (const frame of scanned.frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)));
    } catch (error) {
      return { ok: false, error: `帧@${frame.start} 解压失败：${error.message}` };
    }
  }
  if (parts.length === 0) return { ok: false, error: '没有完整帧' };
  return { ok: true, plaintext: Buffer.concat(parts), frames: scanned.frames.length };
}

/**
 * 检查 JSONL 明文的事件 seq 连续性。第 1 行是 header，跳过。
 * 只报「第一处断口」的成因，不级联（宿主 decoder 的口径也是发现即停）。
 * @param {Buffer} plaintext decodeSessionLog 的 plaintext
 * @returns {{events:number, gaps:Array<object>}}
 */
export function sessionLogSeqGaps(plaintext) {
  const lines = plaintext.toString('utf8').split('\n');
  const gaps = [];
  let expected = 0;
  let events = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      gaps.push({ line: i + 1, error: 'unparsable' });
      continue;
    }
    if (row && typeof row.seq === 'number') {
      if (row.seq !== expected) {
        gaps.push({ line: i + 1, expected, got: row.seq });
        expected = row.seq;
      }
      expected += 1;
      events += 1;
    }
  }
  return { events, gaps };
}
