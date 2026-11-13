/**
 * Live check against a running Harness: is this package's client bundle served?
 *
 * A client bundle is served only while its row is part of the RUNNING
 * composition, so a 200 here proves the install took effect without guessing
 * from configuration files. The bundle URL carries an artifact revision hashed
 * from the file's metadata (mtime/ctime/size), which is reproducible locally.
 *
 * The GUI's own pages are authenticated, so this checks the public bundle route
 * only; the editing route itself answers 401 to anything without the browser's
 * cookie, which is exactly the fence working.
 *
 * Usage: node verify-live.mjs [http://127.0.0.1:<port>]
 *
 * The Desktop GUI's port changes on every launch, so either pass the current
 * URL as the first argument or set DSH_WEB_URL. The fallback below is only a
 * convenience for a throwaway instance on the usual port.
 *
 * @module @local/dsh-preview-editor/verify-live
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:57356';
const name = '@local/dsh-preview-editor';

/**
 * Reproduce client-modules' framed hash.
 *
 * @param domain - the hash domain.
 * @param parts - length-framed parts.
 * @returns the 12-character revision.
 */
function framedHash(domain, parts) {
	const hash = createHash('sha1').update(domain).update('\0');
	for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	return hash.digest('hex').slice(0, 12);
}

/**
 * GET one path on the running app.
 *
 * @param url - the absolute URL.
 * @param needles - markers the body is scanned for.
 * @returns status, length, a short head, and the markers that were present.
 */
function get(url, needles = []) {
	return new Promise((resolve) => {
		const call = request(url, { method: 'GET' }, (res) => {
			let bytes = 0;
			let head = '';
			const found = new Set();
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				// The stream is decoded to UTF-16 strings, so `chunk.length` would count
				// code units and undercount every multi-byte character — this bundle is
				// full of Chinese locale text. Count the real encoded bytes instead.
				bytes += Buffer.byteLength(chunk, 'utf8');
				for (const needle of needles) if (chunk.includes(needle)) found.add(needle);
				if (head.length < 60) head += chunk.slice(0, 60 - head.length);
			});
			res.on('end', () =>
				resolve({
					status: res.statusCode,
					bytes,
					head: head.replaceAll('\n', ' '),
					found: [...found]
				})
			);
		});
		call.on('error', (error) => resolve({ status: 0, bytes: 0, head: String(error.message), found: [] }));
		call.end();
	});
}

const clientFile = path.join(here, 'client.js');
const stat = statSync(clientFile);
const rev = framedHash('plugin-artifact', [
	String(stat.mtimeMs),
	String(stat.ctimeMs),
	String(stat.size)
]);

/**
 * Markers that only the current client half may carry. They cover the flat
 * locale keys, the gutter with its invisible-character marks, the default
 * priority band (builtin), and the visible loading state that fixed the blank
 * Edit pane — so an older bundle cannot pass by carrying just the first few.
 */
const markers = [
	'useCodeHighlighter',
	'action.preview',
	'preview-editor/markdown',
	"'viewer.label': 'Edit'",
	'flat and dotted',
	'data-preview-editor-line',
	'data-preview-editor-gutter',
	'trailing space',
	'marks.eolCrlf',
	'editableAsDefault',
	"'data-preview-editor': 'loading'"
];

const served = await get(`${base}/plugins/??${name}/client.js&rev=${rev}`, markers);
const control = await get(`${base}/plugins/??@local/does-not-exist/client.js&rev=${rev}`);
const gated = await get(`${base}/api/dsh-preview-editor`);

console.log(`base            ${base}`);
console.log(`bundle rev      ${rev}  (client.js size ${stat.size})`);
console.log(`own bundle      ${served.status}  ${served.bytes} bytes  ${served.head}`);
console.log(`expected code   ${served.found.length}/${markers.length} markers  [${served.found.join(', ')}]`);
console.log(`control package ${control.status}`);
console.log(`editing route   ${gated.status} (401 means only the browser's cookie may write)`);

if (served.status !== 200) {
	console.error(
		'\nthe running composition does not serve this bundle yet — the app must load the profile row first, then the page must be reloaded.'
	);
	process.exitCode = 1;
}
const missing = markers.filter((marker) => !served.found.includes(marker));
if (served.status === 200 && missing.length > 0) {
	console.error(
		`\nthe served bundle predates ${missing.join(', ')} — reload the page, and restart the app if the revision never changes.`
	);
	process.exitCode = 1;
}