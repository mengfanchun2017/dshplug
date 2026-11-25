const fs = require('fs');
const path = require('path');
const ASAR = 'C:/Users/franc/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/';
const OUT = 'C:/dsh/dw-plugin/_diag/';

const files = (process.env.FILES || '').split('|').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });
for (const rel of files) {
  const src = ASAR + rel;
  let buf;
  try { buf = fs.readFileSync(src); }
  catch (e) { console.log('MISS ' + rel + ' :: ' + e.message); continue; }
  const dest = OUT + rel.replace(/[\/]/g, '__');
  fs.writeFileSync(dest, buf);
  console.log('OK ' + rel + ' -> ' + dest + ' (' + buf.length + ' bytes)');
}
