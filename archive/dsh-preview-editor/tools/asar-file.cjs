/* 从 app.asar 里按偏移/长度精确取一段文件字节（asar 头为 JSON，entries 里带 offset/size）。
   用途：asar-slice.cjs 只能按「针」找文本，取整份 CSS 会一直命中相邻内容。 */
const fs = require('fs');

const asar = process.argv[2];
const want = process.argv[3];

const fd = fs.openSync(asar, 'r');
// asar 头：8 字节 pickle 头 + 4 字节 size pickle + JSON
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(headerSize);
fs.readSync(fd, jsonBuf, 0, headerSize, 16);
const dataStart = 16 + headerSize;
const tree = JSON.parse(jsonBuf.toString('utf8').replace(/\0+$/, ''));

function find(node, path) {
  let cur = node.files;
  const parts = path.split('/');
  for (const part of parts) {
    if (!cur || !cur[part]) return null;
    cur = cur[part];
    if (cur.files) { cur = cur; } else { return cur; }
  }
  return cur;
}

// 直接递归找 basename
const hits = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p);
    else if (name === want) hits.push({ p, entry });
  }
})(tree, '');

if (hits.length === 0) { console.log('not found: ' + want); process.exit(1); }

for (const { p, entry } of hits.slice(0, 3)) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  console.log('===== ' + p + ' (' + entry.size + ' B) =====');
  console.log(buf.toString('utf8'));
}
fs.closeSync(fd);
