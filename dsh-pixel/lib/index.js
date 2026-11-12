/**
 * Host half of the 'dsh-pixel' plugin.
 *
 * Owns exactly one job the generic pixel store cannot know about: writing an
 * IP asset family. The geometry of an IP is fixed (a native grid plus a
 * documented integer ladder), so the export is not "save a PNG" but
 * "regenerate the documented family" -- every side is an exact multiple of the
 * master, produced with nearest-neighbour sampling, so no file in the family
 * ever carries a half pixel.
 *
 * Everything else (artwork storage, the PNG the editor shows, history) stays in
 * a pixel store plugin; this route never reads or writes that store.
 *
 * @module dsh-pixel
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/** Stable Cordis plugin name, matching the Client half and the patch row id. */
export const name = 'dsh-pixel';

/** Mirrors package.json's version; test/manifest.test.mjs keeps the two equal. */
export const VERSION = '0.1.0';

/** The same-origin host route needs the web server. */
export const inject = ['webServer'];

/** Route the Client half posts artwork to. */
const API_PATH = '/dsh-pixel';

/** Body ceiling: a 2048 x 2048 document is well under this. */
const MAX_BODY = 8 * 1024 * 1024;

/** Slot alphabet shared with the pixel store: one character per palette entry. */
const BASE_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const EXTRA_CHARS = Array.from({ length: 220 }, (_, offset) => String.fromCharCode(0xe000 + offset)).join('');
const CHARS = BASE_CHARS + EXTRA_CHARS;

/**
 * The documented export ladder. A 48 px native grid times these factors gives
 * the side list the sample IP ships (48 through 1008 px), which is also the set
 * a favicon-to-print family needs. The Client half renders the same list.
 */
export const LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 16, 21];

/* ---------------------------------------------------------------- */
/* PNG encoding (zlib + CRC32, no dependencies)                       */
/* ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

/** Encodes straight RGBA bytes as a PNG (filter 0 on every scanline). */
export function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filtering
    ihdr[12] = 0;  // no interlace
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Rasterizes one document at an integer scale.
 * Each source pixel becomes a scale x scale block, which IS the upscale.
 * @param doc - the artwork ({ w, h, palette, layers, slug? }).
 * @param scale - positive integer multiplier.
 * @returns straight RGBA bytes at (w * scale) x (h * scale).
 */
export function renderRgba(doc, scale) {
    const width = doc.w * scale;
    const height = doc.h * scale;
    const rgba = Buffer.alloc(width * height * 4);
    const palette = Array.isArray(doc.palette) ? doc.palette : [];
    const layers = Array.isArray(doc.layers) ? doc.layers : [];
    for (const layer of layers) {
        if (!layer || layer.visible === false || !Array.isArray(layer.rows)) continue;
        for (let y = 0; y < doc.h; y += 1) {
            const row = layer.rows[y] || '';
            for (let x = 0; x < doc.w; x += 1) {
                const slot = CHARS.indexOf(row.charAt(x));
                if (slot < 0) continue;
                const hex = palette[slot];
                if (typeof hex !== 'string' || hex.length !== 7) continue;
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                for (let dy = 0; dy < scale; dy += 1) {
                    let cursor = ((y * scale + dy) * width + x * scale) * 4;
                    for (let dx = 0; dx < scale; dx += 1) {
                        rgba[cursor] = r;
                        rgba[cursor + 1] = g;
                        rgba[cursor + 2] = b;
                        rgba[cursor + 3] = 255;
                        cursor += 4;
                    }
                }
            }
        }
    }
    return { width, height, rgba };
}

/* ---------------------------------------------------------------- */
/* HTTP API                                                          */
/* ---------------------------------------------------------------- */

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (data) => {
            size += data.length;
            if (size > MAX_BODY) {
                reject(new Error('body-too-large'));
                req.destroy();
                return;
            }
            chunks.push(data);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** The Session working directory, so exports land beside the source tree. */
function resolveDirectory(ctx, sessionId) {
    const workingDirectory = ctx.get('workingDirectory');
    const sessions = ctx.get('sessions');
    const session = sessions && typeof sessions.get === 'function' && typeof sessionId === 'string' && sessionId !== ''
        ? sessions.get(sessionId)
        : undefined;
    if (session && workingDirectory && typeof workingDirectory.get === 'function') {
        try {
            const directory = workingDirectory.get(session);
            if (typeof directory === 'string' && directory !== '') return directory;
        } catch {
            // Fall through to the directory recorded in the Session header.
        }
    }
    if (session && session.header && typeof session.header.cwd === 'string' && session.header.cwd !== '') {
        return session.header.cwd;
    }
    if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string') {
        return workingDirectory.defaultDirectory;
    }
    return os.homedir();
}

function clampInt(value, low, high, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(high, Math.max(low, Math.round(number)));
}

/** Validates the incoming document enough to rasterize it safely. */
export function normalize(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('invalid-document');
    const w = clampInt(doc.w, 1, 2048, 48);
    const h = clampInt(doc.h, 1, 2048, 48);
    const palette = Array.isArray(doc.palette)
        ? doc.palette.filter((hex) => typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex))
        : [];
    const layers = Array.isArray(doc.layers) ? doc.layers : [];
    if (palette.length === 0) throw new Error('empty-palette');
    // The file prefix belongs to the deployment, not to the plugin: the Client
    // half attaches its BRAND.slug to the document before every export, and a
    // missing or hostile value falls back instead of reaching the filesystem.
    const slug = typeof doc.slug === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(doc.slug.trim())
        ? doc.slug.trim()
        : 'pixel-mark';
    return {
        name: typeof doc.name === 'string' && doc.name.trim() !== '' ? doc.name.trim() : 'Pixel mark',
        slug,
        w,
        h,
        palette,
        layers: layers.map((layer) => ({
            visible: layer && layer.visible !== false,
            rows: Array.isArray(layer && layer.rows) ? layer.rows : [],
        })),
    };
}

/**
 * Narrows the export to the rungs the caller asked for.
 *
 * Only documented rungs are accepted, so a UI slip can never invent a size
 * that is not an exact multiple of the native grid.
 */
function pickScales(payload) {
    const requested = Array.isArray(payload.scales)
        ? payload.scales
        : Number.isFinite(Number(payload.scale))
            ? [Number(payload.scale)]
            : [];
    const allowed = requested
        .map((value) => Math.round(Number(value)))
        .filter((value) => LADDER.includes(value));
    return allowed.length > 0 ? Array.from(new Set(allowed)) : LADDER.slice();
}

/**
 * Rasterizes the document at every rung of the ladder and writes it into
 * `<directory>/assets/mark`.
 *
 * File names follow the asset family convention (<slug>-<side>.png).
 * Because every side derives from the native grid, re-exporting after an edit
 * overwrites the same names instead of accumulating -2, -3 variants the way a
 * generic save does.
 */
export async function exportLadder(doc, directory, scales) {
    const target = path.join(directory, 'assets', 'mark');
    await fsp.mkdir(target, { recursive: true });
    const written = [];
    for (const scale of scales) {
        const { width, height, rgba } = renderRgba(doc, scale);
        const name = doc.slug + '-' + String(width) + '.png';
        const file = path.join(target, name);
        const png = encodePng(width, height, rgba);
        await fsp.writeFile(file, png);
        written.push({ scale, width, height, bytes: png.length, path: file });
    }
    return { directory: target, written };
}

async function handleRequest(ctx, req, res) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
    }
    let payload;
    try {
        const text = await readBody(req);
        payload = text === '' ? {} : JSON.parse(text);
    } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'body-too-large';
        sendJson(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body-too-large' : 'bad-json' });
        return;
    }
    const op = payload && typeof payload === 'object' ? payload.op : undefined;
    try {
        if (op === 'version') {
            sendJson(res, 200, { ok: true, name, version: VERSION, ladder: LADDER });
            return;
        }
        if (op === 'ladder') {
            sendJson(res, 200, { ok: true, ladder: LADDER });
            return;
        }
        if (op === 'export') {
            const doc = normalize(payload.doc);
            const scales = pickScales(payload);
            const directory = typeof payload.directory === 'string' && payload.directory.trim() !== ''
                ? path.resolve(payload.directory.trim())
                : resolveDirectory(ctx, payload.sessionId);
            const result = await exportLadder(doc, directory, scales);
            sendJson(res, 200, { ok: true, ...result });
            return;
        }
        sendJson(res, 400, { ok: false, error: 'unknown-op' });
    } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'failed' });
    }
}

/**
 * Mounts the export route.
 * @param ctx - plugin context carrying the web server.
 */
export function apply(ctx) {
    ctx.effect(() => {
        const dispose = ctx.webServer.register({
            kind: 'exact',
            path: API_PATH,
            handler: (req, res) => {
                void handleRequest(ctx, req, res);
            },
        });
        return () => {
            dispose();
        };
    }, 'dsh-pixel: asset export route');
}
