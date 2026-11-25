const fs = require('fs');
const path = require('path');

const ASAR = 'C:/Users/franc/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/';
const OUT = 'C:/dsh/dw-plugin/_diag/';

function listDir(dir) {
  const res = [];
  function walk(d, rel) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else res.push(r);
    }
  }
  walk(dir, '');
  return res;
}

const target = process.env.TARGET || 'dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl';
const files = listDir(ASAR + target);
console.log('TARGET files:', files.length);
for (const f of files) console.log('  ' + f);

// dump package.json files of all @deepseek-ai packages that mention zstd/compression
const pkgRoot = ASAR + 'dsh/node_modules/@deepseek-ai/';
let pkgDirs = [];
try { pkgDirs = fs.readdirSync(pkgRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (e) {}
console.log('\n@deepseek-ai packages:', pkgDirs.join(', '));
for (const name of pkgDirs) {
  try {
    const pj = JSON.parse(fs.readFileSync(pkgRoot + name + '/package.json', 'utf8'));
    const deps = Object.assign({}, pj.dependencies, pj.optionalDependencies, pj.peerDependencies);
    const z = Object.keys(deps).filter(k => /zstd|compress|zlib|lz4|brotli/i.test(k));
    if (z.length) console.log('  ' + name + ' -> ' + z.join(','));
  } catch (e) {}
}
