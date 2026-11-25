const fs = require('fs');
const path = require('path');

const ASAR = 'C:/Users/franc/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/';
const ROOT = ASAR + 'dsh/';

const needles = (process.env.NEEDLES || '').split('|').filter(Boolean);
if (!needles.length) { console.log('usage: NEEDLES=a|b node scan.js'); process.exit(1); }

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') { walk(p, out); continue; }
      walk(p, out);
    } else if (/\.(js|cjs|mjs|json|ts)$/.test(ent.name)) {
      out.push(p);
    }
  }
}

const files = [];
walk(ROOT, files);
console.log('files scanned:', files.length);

for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { continue; }
  const s = buf.toString('utf8');
  for (const n of needles) {
    let idx = 0, count = 0;
    while ((idx = s.indexOf(n, idx)) !== -1 && count < 5) {
      count++;
      const start = Math.max(0, idx - 120);
      const end = Math.min(s.length, idx + 200);
      console.log('\n=== ' + f.replace(ASAR, '') + ' :: ' + n + ' @' + idx + ' ===');
      console.log(s.slice(start, end).replace(/\n/g, '\\n'));
      idx += n.length;
    }
  }
}
