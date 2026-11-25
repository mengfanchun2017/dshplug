// 批量扫描所有 session.v4.jsonl.zstd 的 seq 连续性
const fs = require('fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_MAGIC = 0xFD2FB528;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic @${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset); offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error('reserved bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error('reserved block type');
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
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

function analyze(file) {
  const buf = fs.readFileSync(file);
  const r = { file, bytes: buf.length };
  let frames, tornStart;
  try {
    const scan = scanZstdFrames(buf);
    frames = scan.frames; tornStart = scan.tornStart;
  } catch (e) { r.error = 'scan: ' + e.message; return r; }
  r.frames = frames.length; r.torn = tornStart !== undefined;
  const parts = [];
  let failed = 0;
  for (const { start, end } of frames) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); }
    catch (e) { failed++; }
  }
  r.failedFrames = failed;
  if (failed) { r.error = `failed frames: ${failed}`; return r; }
  const text = Buffer.concat(parts).toString('utf8');
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  r.lines = lines.length;
  let parseErrors = 0;
  let minSeq = Infinity, maxSeq = -Infinity;
  let prev = null;
  const gaps = [];
  let seqCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { parseErrors++; continue; }
    const seq = obj.seq;
    if (typeof seq !== 'number') { parseErrors++; continue; }
    seqCount++;
    if (seq < minSeq) minSeq = seq;
    if (seq > maxSeq) maxSeq = seq;
    if (prev !== null && seq !== prev + 1) {
      gaps.push({ row: i + 1, expected: prev + 1, got: seq });
      if (gaps.length > 50) { r.gaps = gaps; r.gapOverflow = true; }
    }
    prev = seq;
  }
  r.parseErrors = parseErrors;
  r.events = seqCount;
  r.minSeq = minSeq === Infinity ? null : minSeq;
  r.maxSeq = maxSeq === -Infinity ? null : maxSeq;
  r.gaps = gaps;
  return r;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/session.*\.jsonl\.zstd$/.test(ent.name)) out.push(p);
  }
}

const root = 'C:/Users/franc/.dsh/sessions';
const files = [];
walk(root, files);
console.log('total session files:', files.length);

const results = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const r = analyze(f);
  results.push(r);
  const flag = r.error ? 'ERR' : (r.gaps && r.gaps.length ? 'GAP' : 'ok');
  console.log(`[${i + 1}/${files.length}] ${flag} ${path.relative(root, f)} frames=${r.frames} lines=${r.lines} events=${r.events} seq=${r.minSeq}..${r.maxSeq} gaps=${r.gaps ? r.gaps.length : 0} ${r.error || ''}`);
}

fs.writeFileSync('C:/dsh/dw-plugin/_diag/session_scan.json', JSON.stringify(results, null, 2));
console.log('\nwrote session_scan.json');
