import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/**
 * Host-half tests: the export contract, not the HTTP plumbing.
 *
 * The route itself is exercised live in a DSH profile; what can be pinned down
 * here is the part that silently rots -- the ladder math, the PNG bytes and the
 * three-way name agreement (package.json / cordis.patch.yml / export const name).
 *
 * Run: node test/host.test.mjs
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const { name, VERSION, LADDER, encodePng, renderRgba, normalize, exportLadder } = await import(
  new URL("../lib/index.js", import.meta.url).href
);

/* -------------------------------------------------------------- manifest */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const patch = fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8");

assert.equal(name, "dsh-pixel", "host export const name");
assert.equal(pkg.name, "dsh-pixel", "package.json name");
assert.equal(VERSION, pkg.version, "VERSION mirrors package.json");
assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml", "dsh.bundle.patch declared");
assert.match(patch, /-\s*id:\s*dsh-pixel\b/, "patch row id matches export const name");

const listJson = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "list.json"), "utf8"));
const entry = listJson.plugins.find((plugin) => plugin.name === "dsh-pixel");
assert.ok(entry, "registered in list.json");
assert.equal(entry.version, pkg.version, "list.json version in sync");
assert.equal(entry.status, "active", "list.json status");
assert.equal(entry.dir, "dsh-pixel", "list.json dir");
// No packageName bridge: the directory and the package are the same string.
assert.equal(entry.packageName, undefined, "no packageName needed when dir === name");

/* ---------------------------------------------------------------- ladder */
assert.deepEqual(LADDER, [1, 2, 3, 4, 5, 6, 8, 10, 16, 21]);
const NATIVE = 48;
for (const scale of LADDER) {
  const side = NATIVE * scale;
  assert.equal(side % NATIVE, 0, `${side} is an integer multiple of ${NATIVE}`);
}
// Above the native grid the ladder is the only legal source of a side: 64 is
// absent on purpose (48 x 4/3 is not an integer), so the small favicon sizes are
// hand-drawn on their own grids instead of being resampled into existence.
const ladders = new Set(LADDER.map((scale) => NATIVE * scale));
/** Sizes drawn by hand on their own grid, plus the 512 social canvas. */
const HAND_DRAWN = new Set([16, 24, 32, 64]);
const SOCIAL_CANVAS = 512;

/* ------------------------------------------------------------- rendering */
const doc = {
  w: 4,
  h: 4,
  name: "test",
  slug: "unit-mark",
  palette: ["#ff0000", "#00ff00"],
  layers: [
    { visible: true, rows: ["1...", "....", "..0.", "...."] },
    // A hidden layer must not contribute pixels.
    { visible: false, rows: ["0000", "0000", "0000", "0000"] },
  ],
};

for (const scale of LADDER) {
  const { width, height, rgba } = renderRgba(doc, scale);
  assert.equal(width, doc.w * scale, "width is an integer multiple");
  assert.equal(height, doc.h * scale, "height is an integer multiple");
  assert.equal(rgba.length, width * height * 4, "RGBA length");

  // Top-left block is palette[1] (green), and it is a solid scale x scale block.
  for (let y = 0; y < scale; y += 1) {
    for (let x = 0; x < scale; x += 1) {
      const i = (y * width + x) * 4;
      assert.deepEqual([rgba[i], rgba[i + 1], rgba[i + 2]], [0, 255, 0], "block is uniform");
    }
  }
  // The hidden layer's red pixel must stay transparent.
  const hidden = scale * 3;
  const i = (hidden * width + scale * 2) * 4;
  assert.equal(rgba[i + 3], 0, "hidden layer contributes nothing");
}

/* ------------------------------------------------------------------ PNG */
const { width, height, rgba } = renderRgba(doc, 2);
const png = encodePng(width, height, rgba);
assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");

// Walk the chunks: IHDR must describe the raster we just encoded, and the
// concatenated IDAT payload must inflate back to filter-0 scanlines.
let cursor = 8;
const seen = {};
const idat = [];
while (cursor < png.length) {
  const length = png.readUInt32BE(cursor);
  const type = png.toString("ascii", cursor + 4, cursor + 8);
  const data = png.subarray(cursor + 8, cursor + 8 + length);
  seen[type] = (seen[type] || 0) + 1;
  if (type === "IHDR") {
    assert.equal(data.readUInt32BE(0), width, "IHDR width");
    assert.equal(data.readUInt32BE(4), height, "IHDR height");
    assert.equal(data[8], 8, "bit depth");
    assert.equal(data[9], 6, "colour type RGBA");
  }
  if (type === "IDAT") idat.push(data);
  cursor += 12 + length;
}
assert.equal(seen.IHDR, 1, "one IHDR");
assert.equal(seen.IEND, 1, "one IEND");

const raw = zlib.inflateSync(Buffer.concat(idat));
assert.equal(raw.length, (width * 4 + 1) * height, "scanline count");
for (let y = 0; y < height; y += 1) {
  assert.equal(raw[y * (width * 4 + 1)], 0, "filter byte 0 on every scanline");
}

/* ------------------------------------------------------- normalize + export */
// A regression guard: `slug` used to be declared in renderRgba and read in
// normalize, so every export died with `slug is not defined` and only a live
// HTTP call revealed it. These assertions make that class of bug loud.
const bare = { ...doc };
delete bare.slug;
const normalized = normalize({ ...doc, slug: 'my-mark' });
assert.equal(normalized.slug, 'my-mark', 'slug survives normalize');
assert.equal(normalize(bare).slug, 'pixel-mark', 'slug defaults');
assert.equal(normalize({ ...bare, slug: '../evil' }).slug, 'pixel-mark', 'slug rejects traversal');
assert.equal(normalize({ ...bare, slug: 'a b' }).slug, 'pixel-mark', 'slug rejects spaces');

const scratch = path.join(ROOT, ".tmp-export-" + process.pid);
try {
  const result = await exportLadder(normalized, scratch, [1, 2]);
  assert.equal(result.written.length, 2, 'two rungs written');
  for (const entry of result.written) {
    assert.equal(entry.width, normalized.w * entry.scale, 'width follows the scale');
    assert.ok(entry.path.endsWith(`my-mark-${entry.width}.png`), 'file name uses the slug');
    assert.ok(fs.existsSync(entry.path), 'file landed on disk');
    const bytes = fs.readFileSync(entry.path);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'real PNG');
  }
  // Re-exporting overwrites instead of accumulating -2, -3 variants.
  const again = await exportLadder(normalized, scratch, [1, 2]);
  assert.deepEqual(
    again.written.map((w) => path.basename(w.path)).sort(),
    result.written.map((w) => path.basename(w.path)).sort(),
    'same names on re-export'
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

/* ------------------------------------------------------------- assets */
// The shipped family is the sample artwork; when it is present it must obey the
// same integer rule the exporter enforces.
const markDir = path.join(ROOT, "assets", "mark");
if (fs.existsSync(markDir)) {
  const files = fs.readdirSync(markDir).filter((file) => file.endsWith(".png"));
  assert.ok(files.length > 0, "asset family present");
  for (const file of files) {
    const side = Number(file.replace(/^.*-(\d+)\.png$/, "$1"));
    assert.ok(Number.isFinite(side), `${file} carries a side in its name`);
    assert.ok(
      HAND_DRAWN.has(side) || side === SOCIAL_CANVAS || ladders.has(side),
      `${file}: ${side}px must be a ladder rung, a hand-drawn favicon size, or the social canvas`
    );
  }
}

console.log("host: ok (" + (fs.existsSync(markDir) ? fs.readdirSync(markDir).length + " asset files checked" : "no assets") + ")");
