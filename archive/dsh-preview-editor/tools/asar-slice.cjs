// Slice a byte window out of app.asar around a plain-text needle.
// Usage: node asar-slice.cjs <asar> <needle> [before] [after] [maxHits]
const fs = require('fs');

const [, , file, needle, before = '400', after = '800', maxHits = '3'] = process.argv;
if (!file || !needle) {
  console.error('usage: node asar-slice.cjs <asar> <needle> [before] [after] [maxHits]');
  process.exit(2);
}
const b = fs.readFileSync(file);
const pat = Buffer.from(needle, 'utf8');
const B = Number(before);
const A = Number(after);
const max = Number(maxHits);

let i = 0;
let hits = 0;
while ((i = b.indexOf(pat, i)) !== -1 && hits < max) {
  const s = Math.max(0, i - B);
  const e = Math.min(b.length, i + A);
  const text = b.slice(s, e).toString('utf8').replace(/[^\x20-\x7e\n\u4e00-\u9fff]/g, ' ');
  console.log('=== offset ' + i + ' ===');
  console.log(text);
  console.log();
  i += 1;
  hits += 1;
}
if (hits === 0) console.log('no hit for: ' + needle);
