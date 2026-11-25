// 诊断 session.v4.jsonl.zstd：逐帧解压 + 分析事件 seq
const fs = require('fs');
const zlib = require('node:zlib');

const ZSTD_MAGIC = 0xFD2FB528;

function scanZstdFrames(buffer, maxFrames = Infinity) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at ${offset - 1}`);
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
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error(`reserved block type at ${offset - 3}`);
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
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

async function main() {
  const file = process.argv[2];
  const buf = fs.readFileSync(file);
  console.log('file:', file, 'bytes:', buf.length);

  const { frames, tornStart } = scanZstdFrames(buf);
  console.log('frames:', frames.length, 'tornStart:', tornStart);

  const parts = [];
  let bad = 0;
  for (let i = 0; i < frames.length; i++) {
    const { start, end } = frames[i];
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
    } catch (e) {
      bad++;
      console.log(`frame ${i} [${start},${end}) FAILED: ${e.message}`);
    }
  }
  console.log('decoded frames:', parts.length, 'failed:', bad);
  const all = Buffer.concat(parts);
  console.log('plaintext bytes:', all.length);

  const text = all.toString('utf8');
  const lines = text.split('\n');
  // 去掉末尾空行
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  console.log('lines:', lines.length);

  // 逐行解析
  let header = null;
  const rows = [];
  let parseErrors = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch (e) { parseErrors++; if (parseErrors < 10) console.log(`line ${i + 1} JSON parse fail: ${e.message} :: ${line.slice(0, 120)}`); continue; }
    if (i === 0) header = obj;
    else rows.push({ row: i + 1, obj });
  }
  console.log('header:', JSON.stringify(header).slice(0, 600));
  console.log('event rows:', rows.length, 'parseErrors:', parseErrors);

  // seq 分析
  const seqs = [];
  for (const { row, obj } of rows) {
    seqs.push({ row, seq: obj.seq, type: obj.type });
  }
  // 找 gap
  let prev = null;
  const gaps = [];
  for (let i = 0; i < seqs.length; i++) {
    const s = seqs[i];
    if (prev !== null) {
      const expected = prev + 1;
      if (s.seq !== expected) {
        gaps.push({ row: s.row, expected, got: s.seq, prevRow: seqs[i - 1].row, prevSeq: prev });
      }
    }
    prev = s.seq;
  }
  console.log('\nseq gaps (first 20):');
  for (const g of gaps.slice(0, 20)) console.log('  ', JSON.stringify(g));
  console.log('total gaps:', gaps.length);

  // 输出 row 1168..1180 附近
  console.log('\nrows 1165..1185:');
  for (const s of seqs) {
    if (s.row >= 1165 && s.row <= 1185) console.log('  ', JSON.stringify(s));
  }

  // 尾部
  console.log('\nlast 10 rows:');
  for (const s of seqs.slice(-10)) console.log('  ', JSON.stringify(s));

  // seq 唯一性
  const seen = new Map();
  let dup = 0;
  for (const s of seqs) {
    if (seen.has(s.seq)) { dup++; if (dup <= 10) console.log('dup seq', s.seq, 'rows', seen.get(s.seq), s.row); }
    else seen.set(s.seq, s.row);
  }
  console.log('duplicate seqs:', dup);
  const seqVals = seqs.map(s => s.seq);
  console.log('seq min/max:', Math.min(...seqVals), Math.max(...seqVals));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
