/**
 * Dependency-free verification for `@local/dsh-preview-editor`.
 *
 * It exercises the real halves of the plugin outside DSH:
 *
 * 1. the Host route handler end to end against a real filesystem, including the
 *    CRLF round trip, the version guard, and every refusal path;
 * 2. the Client bundle's registration, run through `__ModuleLoader__` in a VM,
 *    including a hook-shim render of the body in its ready and failed states.
 *
 * Run: node verify.mjs
 *
 * @module @local/dsh-preview-editor/verify
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '.verify');
const ROUTE = '/api/dsh-preview-editor';

/** Collected outcomes; `node verify.mjs` exits non-zero when any failed. */
const results = [];

/**
 * Run one named check.
 *
 * @param name - the check's description.
 * @param fn - the check body.
 */
async function test(name, fn) {
	try {
		await fn();
		results.push({ ok: true, name });
	} catch (error) {
		results.push({ ok: false, name, detail: String(error?.message ?? error) });
	}
}

/**
 * A filesystem backend with the same shape `ctx.fs` exposes, backed by real
 * files under the workspace. Versions are content digests, so the guard is
 * deterministic regardless of timestamp resolution.
 *
 * @returns the stand-in service plus the calls it observed.
 */
function makeFs() {
	const calls = [];
	// Argument shapes are recorded too: the shipped tools pass resolution
	// options as `{ cwd, signal }`, reads as `(target, signal)`, and mutations as
	// `(target, content, expected, signal, policy)`. Parity with those call sites
	// is the reason this route can reuse `ctx.fs` safely.
	const shapes = { resolutions: [], stat: [], readText: [], writeText: [] };
	const versionOf = (bytes) => `h:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
	return {
		calls,
		shapes,
		async resolve(requested, opts) {
			shapes.resolutions.push(opts);
			return {
				targetKey: path.isAbsolute(requested)
					? requested
					: path.resolve(opts?.cwd ?? root, requested),
				displayPath: requested
			};
		},
		async stat(target, ...rest) {
			shapes.stat.push(rest.length + 1);
			try {
				const stat = await fs.stat(target.targetKey);
				const bytes = stat.isFile() ? await fs.readFile(target.targetKey) : undefined;
				return {
					version: bytes === undefined ? 'dir' : versionOf(bytes),
					type: stat.isFile() ? 'file' : 'directory',
					size: stat.size
				};
			} catch {
				return undefined;
			}
		},
		async readText(target, ...rest) {
			shapes.readText.push(rest.length + 1);
			return fs.readFile(target.targetKey, 'utf8');
		},
		async writeText(target, content, expected, _signal, policy) {
			shapes.writeText.push(arguments.length);
			const bytes = await fs.readFile(target.targetKey).catch(() => undefined);
			if (expected?.kind === 'replaceIfVersion') {
				if (bytes === undefined) throw failure('FS_STALE_VERSION', 'file no longer exists');
				if (versionOf(bytes) !== expected.version) {
					throw failure('FS_STALE_VERSION', 'file changed since it was read');
				}
			}
			calls.push({ target: target.targetKey, policy, expected });
			await fs.writeFile(target.targetKey, content, 'utf8');
			const after = await fs.readFile(target.targetKey);
			return { operation: bytes === undefined ? 'create' : 'update', version: versionOf(after) };
		},
		processPath: (target) => target.targetKey
	};
}

/**
 * Copy a string list into this realm, so a bundle loaded in another VM context
 * compares by value instead of by prototype identity.
 *
 * @param value - an array-like of strings.
 * @returns a local array of strings.
 */
function list(value) {
	return Array.from(value, (entry) => String(entry));
}

/**
 * Build an error carrying an `FsError`-style code.
 *
 * @param code - the stable code.
 * @param message - the human message.
 * @returns the error.
 */
function failure(code, message) {
	return Object.assign(new Error(message), { code });
}

/**
 * Load the Host half against a stand-in context.
 *
 * @param options - `mode` for the sandbox policy and the cap the row config sets.
 * @returns the claimed route and what the harness observed.
 */
async function hostHarness(options = {}) {
	const host = await import(new URL('./index.js', import.meta.url).href);
	const fsApi = makeFs();
	const observed = {
		deps: undefined,
		routes: [],
		policies: [],
		written: fsApi.calls,
		shapes: fsApi.shapes,
		events: [],
		globals: []
	};
	const scope = {
		fs: fsApi,
		logger: { info() {} },
		sandboxPolicy: {
			resolve(request) {
				const policy = {
					mode: options.mode ?? 'workspace-write',
					workspaceRoot: root,
					sessionId: request?.session?.header?.id
				};
				observed.policies.push(policy);
				return policy;
			}
		},
		sessions: {
			get(id) {
				return id === 's1' ? { header: { id, cwd: root } } : undefined;
			}
		},
		connection: {
			fetch: {
				register(route) {
					observed.routes.push(route);
					return () => {};
				}
			}
		},
		effect(fn) {
			return fn();
		}
	};
	host.apply(
		{
			inject(deps, callback) {
				observed.deps = deps;
				callback(scope);
			},
			on(event, handler) {
				observed.events.push(event);
				handler({ push: (row) => observed.globals.push(row) });
			}
		},
		options.noConfig === true
			? undefined
			: (options.config ?? { maxBytes: options.maxBytes ?? 4096 })
	);
	return { host, route: observed.routes[0], observed };
}

/**
 * POST one JSON body to the claimed route.
 *
 * @param route - the route the Host claimed.
 * @param body - the request payload.
 * @returns the parsed reply.
 */
async function post(route, body) {
	const reply = await route.fetch(
		new Request(`http://127.0.0.1${ROUTE}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
	return reply.json();
}

/**
 * Load the Client bundle through a stand-in `__ModuleLoader__` and a stand-in
 * `require`.
 *
 * @param react - the `react` stand-in the factory receives.
 * @returns the module exports and the module ids the bundle requested.
 */
async function loadClient(react, primitives) {
	const code = await fs.readFile(path.join(here, 'client.js'), 'utf8');
	let definition;
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(candidate) {
					definition = candidate;
				}
			}
		},
		TextEncoder,
		AbortController,
		URL,
		console,
		// The rendered Markdown view resolves relative images against the app origin.
		document: { baseURI: 'http://127.0.0.1:57356/' },
		requestAnimationFrame: (fn) => fn(),
		setTimeout,
		clearTimeout
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });
	assert.ok(definition !== undefined, 'the bundle never called __ModuleLoader__.load');
	assert.equal(definition.id, '@local/dsh-preview-editor');
	const requested = [];
	const exports_ = definition.factory((id) => {
		requested.push(id);
		if (id === 'react') return react;
		if (id === '@deepseek-ai/dsh-client-ui-primitives') {
			if (primitives === undefined) throw new Error('module not provided');
			return primitives;
		}
		throw new Error(`unexpected module request ${id}`);
	});
	return { exports: exports_, requested };
}

/**
 * A stand-in for the platform highlighter.
 *
 * Mirrors the shape the shell publishes: `languageForPath(file)` names one
 * language per path, and `useCodeHighlighter(language)` returns a synchronous
 * `(code) => lines of {text, style}` that yields `undefined` when it has no
 * tokens. Like shiki, it drops a trailing empty line.
 *
 * @param options - `languages` maps a suffix to a language id, `tokens` turns one
 *   line into its tokens, `unknown` forces "no tokens", `noMarkdown` drops the
 *   renderer the way a shell that never shipped one would.
 * @returns the primitives stand-in.
 */
function primitivesStub(options = {}) {
	const languages = options.languages ?? { ts: 'typescript', py: 'python' };
	const markdownText = (props) => ({
		type: 'div',
		props: {
			'data-markdown-text': props.text,
			'data-markdown-labels': props.labels,
			'data-markdown-path-images': props.pathImages,
			children: null
		}
	});
	return {
		MarkdownText: options.noMarkdown === true ? undefined : markdownText,
		languageForPath(filePath) {
			const suffix = String(filePath).split('.').at(-1).toLowerCase();
			return languages[suffix];
		},
		useCodeHighlighter() {
			return (code) => {
				if (options.unknown === true) return undefined;
				let lines = String(code).split('\n');
				if (lines.length > 1 && lines.at(-1) === '') lines = lines.slice(0, -1);
				return lines.map((line) =>
					(options.tokens ?? ((text) => [{ text, style: { color: 'var(--shiki-token-keyword)' } }]))(line)
				);
			};
		}
	};
}

/**
 * Collect every element in a rendered tree.
 *
 * @param node - a rendered element or a nested array.
 * @param into - the accumulator.
 * @returns every element, depth first.
 */
function elements(node, into = []) {
	if (Array.isArray(node)) {
		for (const entry of node) elements(entry, into);
		return into;
	}
	if (node === null || node === undefined || typeof node !== 'object') return into;
	if (typeof node.type === 'function') {
		// React would call the component, so the walk does too; that is what makes
		// the layer component's own elements visible to these assertions.
		elements(node.type(node.props ?? {}), into);
		return into;
	}
	if (node.type !== undefined) {
		into.push(node);
		elements(node.props?.children, into);
	}
	return into;
}

/**
 * Copy a value out of the client module's realm.
 *
 * The bundle runs inside its own `vm` context, so an array or an object it created
 * carries that context's prototype, and `assert.deepEqual` — the strict form, in
 * this file — then reports "same structure but are not reference-equal" instead of
 * comparing the contents. Everything these assertions compare is JSON-shaped, so
 * one round trip brings it back into this file's realm.
 *
 * @param value - a value the client module produced.
 * @returns the same value, rebuilt in this realm.
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * A hook shim sufficient to render the body once, with preselected state.
 *
 * @param seed - the values `useState` returns in call order.
 * @returns a `react` stand-in.
 */
function reactShim(seed = []) {
	let slot = 0;
	const boxes = [];
	return {
		Fragment: Symbol.for('react.fragment'),
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children }
		}),
		useState(initial) {
			const index = slot++;
			if (seed[index] !== undefined) return [seed[index], () => {}];
			if (boxes[index] === undefined) {
				boxes[index] = typeof initial === 'function' ? initial() : initial;
			}
			return [boxes[index], () => {}];
		},
		useRef(initial) {
			const index = slot++;
			boxes[index] ??= { current: initial };
			return boxes[index];
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		// The body defers only the highlighted copy of the text, so the shim can
		// hand the same value straight back.
		useDeferredValue: (value) => value,
		useEffect() {
			slot++;
		}
	};
}

/**
 * Load the Client half against a stand-in context.
 *
 * @param config - the row config the client half receives.
 * @returns the module exports and everything `apply` registered.
 */
async function clientHarness(config, options = {}) {
	const { exports: client } = await loadClient(reactShim(options.seed), options.primitives);
	const registered = { definitions: [], bodies: [], dictionaries: [] };
	// Mirror `LocaleRuntime`: `register` stores a dictionary object verbatim, and
	// `bind(ns)` translates one *flat* key against it, walking the active locale then
	// `en`, and finally showing the key itself. The previous `() => key` stub hid the
	// very defect this file has to catch: a nested dictionary makes every string
	// render as its own key in the app, and used to pass verification here.
	const localeDicts = new Map();
	const activeLocale = options.locale ?? 'en';
	const chain = activeLocale === 'en' ? ['en'] : [activeLocale, 'en'];
	const ctx = {
		effect(fn) {
			return fn();
		},
		locale: {
			bind: (namespace) => (key) => {
				const entries = localeDicts.get(namespace);
				for (const locale of chain) {
					const value = entries?.[locale]?.[key];
					if (value !== undefined) return value;
				}
				return key;
			},
			register(namespace, dictionaries) {
				registered.dictionaries.push({ namespace, dictionaries });
				localeDicts.set(namespace, dictionaries);
				return () => {};
			}
		},
		documentPreviews: {
			register(definition) {
				registered.definitions.push(definition);
				return () => {};
			}
		},
		slots: {
			inject(name, callback) {
				registered.slot = name;
				return callback();
			},
			register(meta, component) {
				registered.bodies.push({ meta, component });
				return () => {};
			}
		},
		logger: { info() {} }
	};
	client.apply(ctx, config);
	// The namespace-bound translator the slot would hand the body as `props.t`.
	registered.translate = ctx.locale.bind('previewEditor');
	return { client, registered };
}

// ── Host: registration ──────────────────────────────────────────────────────

await test('host claims one POST route on the /api bridge', async () => {
	const { route, observed } = await hostHarness();
	assert.deepEqual(observed.deps, ['connection', 'sandboxPolicy', 'sessions']);
	assert.ok(route !== undefined, 'no route was claimed');
	assert.equal(route.path, ROUTE);
	assert.deepEqual(route.methods, ['POST']);
	assert.equal(route.requestBody, 'buffered');
	assert.equal(typeof route.fetch, 'function');
});

await test('the host embeds this row\'s settings in the page for the browser half', async () => {
	const { observed } = await hostHarness({ config: { markdown: true, maxBytes: 2048 } });
	assert.deepEqual(observed.events, ['webserver/index-inject']);
	assert.equal(observed.globals.length, 1);
	assert.equal(observed.globals[0].kind, 'global');
	assert.equal(observed.globals[0].name, '__DSH_PREVIEW_EDITOR_CONFIG__');
	assert.deepEqual(observed.globals[0].value, { markdown: true, maxBytes: 2048 });
	const bare = await hostHarness({ noConfig: true });
	assert.deepEqual(bare.observed.globals[0].value, {}, 'an absent config must still be embeddable');
});

// ── Host: the editing round trip ────────────────────────────────────────────

await test('read returns the exact text, size, version, and absolute path', async () => {
	await fs.mkdir(root, { recursive: true });
	const file = path.join(root, 'crlf.txt');
	await fs.writeFile(file, 'alpha\r\nbeta\r\n', 'utf8');
	const { route, observed } = await hostHarness();
	const reply = await post(route, { op: 'read', sessionId: 's1', path: 'crlf.txt' });
	assert.equal(reply.ok, true);
	assert.equal(reply.text, 'alpha\r\nbeta\r\n');
	assert.equal(reply.size, 13);
	assert.equal(typeof reply.version, 'string');
	assert.equal(reply.absolutePath, file);
	// Call-site parity with the shipped tools, which is what makes reusing
	// `ctx.fs` here safe rather than hopeful.
	const resolution = observed.shapes.resolutions.at(-1);
	assert.deepEqual(Object.keys(resolution).sort(), ['cwd', 'signal']);
	assert.equal(resolution.cwd, root, 'a relative path resolves against the workspace root');
	assert.equal(observed.shapes.stat.at(-1), 2, 'stat takes (target, signal)');
	assert.equal(observed.shapes.readText.at(-1), 2, 'readText takes (target, signal)');
});

await test('a save of the unmodified text leaves the bytes identical', async () => {
	const file = path.join(root, 'roundtrip.txt');
	const original = 'one\r\ntwo\r\nthree\r\n';
	await fs.writeFile(file, original, 'utf8');
	const { route, observed } = await hostHarness();
	const read = await post(route, { op: 'read', sessionId: 's1', path: 'roundtrip.txt' });
	const saved = await post(route, {
		op: 'save',
		sessionId: 's1',
		path: 'roundtrip.txt',
		text: read.text,
		version: read.version
	});
	assert.equal(saved.ok, true);
	assert.equal(saved.operation, 'update');
	assert.equal(await fs.readFile(file, 'utf8'), original);
	assert.equal(observed.written[0].policy.sessionId, 's1');
	assert.equal(observed.written[0].policy.mode, 'workspace-write');
	assert.deepEqual(observed.written[0].expected, { kind: 'replaceIfVersion', version: read.version });
	assert.equal(
		observed.shapes.writeText.at(-1),
		5,
		'writeText takes (target, content, expected, signal, policy)'
	);
});

await test('an edited save writes exactly the given bytes', async () => {
	const file = path.join(root, 'edited.txt');
	await fs.writeFile(file, 'a\nb\n', 'utf8');
	const { route } = await hostHarness();
	const read = await post(route, { op: 'read', sessionId: 's1', path: 'edited.txt' });
	const saved = await post(route, {
		op: 'save',
		sessionId: 's1',
		path: 'edited.txt',
		text: 'a\nB\nc\n',
		version: read.version
	});
	assert.equal(saved.ok, true);
	assert.equal(await fs.readFile(file, 'utf8'), 'a\nB\nc\n');
});

await test('a file changed elsewhere fails the guard and is left alone', async () => {
	const file = path.join(root, 'stale.txt');
	await fs.writeFile(file, 'first\n', 'utf8');
	const { route } = await hostHarness();
	const read = await post(route, { op: 'read', sessionId: 's1', path: 'stale.txt' });
	await fs.writeFile(file, 'someone else wrote this\n', 'utf8');
	const saved = await post(route, {
		op: 'save',
		sessionId: 's1',
		path: 'stale.txt',
		text: 'mine\n',
		version: read.version
	});
	assert.equal(saved.ok, false);
	assert.equal(saved.code, 'FS_STALE_VERSION');
	assert.equal(await fs.readFile(file, 'utf8'), 'someone else wrote this\n');
});

// ── Host: refusals ─────────────────────────────────────────────────────────

await test('an unknown session is refused, not fenced to the deployment', async () => {
	const { route, observed } = await hostHarness();
	const reply = await post(route, { op: 'read', sessionId: 'nobody', path: 'crlf.txt' });
	assert.equal(reply.ok, false);
	assert.equal(reply.code, 'FS_NO_SESSION');
	assert.equal(observed.policies.length, 0);
});

await test('a missing file, a directory, and oversize reads are refused', async () => {
	const dir = path.join(root, 'adir');
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(200), 'utf8');
	const { route } = await hostHarness({ maxBytes: 64 });
	const missing = await post(route, { op: 'read', sessionId: 's1', path: 'nope.txt' });
	assert.equal(missing.code, 'FS_NOT_FOUND');
	const directory = await post(route, { op: 'read', sessionId: 's1', path: 'adir' });
	assert.equal(directory.code, 'FS_NOT_REGULAR_FILE');
	const big = await post(route, { op: 'read', sessionId: 's1', path: 'big.txt' });
	assert.equal(big.code, 'FS_TOO_LARGE');
});

await test('an oversize save is refused before the filesystem sees it', async () => {
	const file = path.join(root, 'small.txt');
	await fs.writeFile(file, 'ok\n', 'utf8');
	const { route, observed } = await hostHarness({ maxBytes: 64 });
	const read = await post(route, { op: 'read', sessionId: 's1', path: 'small.txt' });
	const saved = await post(route, {
		op: 'save',
		sessionId: 's1',
		path: 'small.txt',
		text: 'y'.repeat(200),
		version: read.version
	});
	assert.equal(saved.code, 'FS_TOO_LARGE');
	assert.equal(observed.written.length, 0);
	assert.equal(await fs.readFile(file, 'utf8'), 'ok\n');
});

await test('malformed requests are refused with a stable code', async () => {
	const { route } = await hostHarness();
	const noPath = await post(route, { op: 'read', sessionId: 's1' });
	assert.equal(noPath.code, 'E_BAD_REQUEST');
	const unknown = await post(route, { op: 'delete', sessionId: 's1', path: 'crlf.txt' });
	assert.equal(unknown.code, 'E_BAD_REQUEST');
	const noText = await post(route, { op: 'save', sessionId: 's1', path: 'crlf.txt' });
	assert.equal(noText.code, 'E_BAD_REQUEST');
});

// ── Client: registration ────────────────────────────────────────────────────

await test('the bundle registers through the module loader with only platform imports', async () => {
	const { exports: client, requested } = await loadClient(reactShim(), primitivesStub());
	assert.deepEqual([...new Set(requested)].sort(), [
		'@deepseek-ai/dsh-client-ui-primitives',
		'react'
	]);
	assert.equal(client.name, 'preview-editor');
	assert.deepEqual(list(client.inject), ['documentPreviews', 'slots', 'locale']);
	assert.equal(typeof client.apply, 'function');
	assert.equal(typeof client.EditorBody, 'function');
});

await test('the renderer claims the code suffixes and offers markdown without stealing it', async () => {
	const { registered } = await clientHarness(undefined);
	assert.equal(registered.definitions.length, 2);
	const definition = registered.definitions[0];
	assert.equal(definition.id, '@local/dsh-preview-editor/text');
	assert.equal(definition.priority, 'builtin', 'the shipped viewers must stay the default');
	assert.equal(definition.loading, 'renderer');
	assert.equal(definition.wrap, false);
	assert.equal(typeof definition.title, 'function');
	assert.ok(definition.extensions.includes('ts'), 'typescript is not claimed');
	assert.ok(definition.extensions.includes('py'), 'python is not claimed');
	// The plain-text family matters most: these have no built-in code preview (the
	// shell's `languageForPath` table has no entry for `txt`), so this renderer is
	// the only thing standing between the user and an external plain-text editor.
	for (const suffix of [
		'txt',
		'text',
		'log',
		'ini',
		'cfg',
		'conf',
		'env',
		'properties',
		'editorconfig',
		'gitignore',
		'csv',
		'tsv'
	]) {
		assert.ok(definition.extensions.includes(suffix), `${suffix} must stay editable in place`);
	}
	assert.ok(!definition.extensions.includes('md'), 'markdown is claimed by the markdown band instead');
	for (const suffix of definition.extensions) {
		assert.equal(suffix, suffix.toLowerCase());
		assert.ok(!suffix.startsWith('.'), `suffix ${suffix} keeps its dot`);
	}
	// Both renderers register in the shipped `builtin` band. The registry ranks
	// `priority === 'builtin' ? 0 : 1` first, then the longest matched suffix, then
	// registration order — so the platform's Code / Text / Markdown viewers, which
	// register earlier, win the default, and Edit becomes the last entry of the
	// viewer menu. `editableAsDefault: true` restores the old `extension` band.
	const markdown = registered.definitions[1];
	assert.equal(markdown.id, '@local/dsh-preview-editor/markdown');
	assert.equal(markdown.priority, 'builtin', 'the rendered Markdown preview stays the default');
	assert.equal(markdown.loading, 'renderer');
	for (const suffix of ['md', 'markdown', 'mdx', 'mdown', 'mkd']) {
		assert.ok(markdown.extensions.includes(suffix), `${suffix} is not editable`);
	}
	assert.equal(registered.bodies.length, 2);
	for (const body of registered.bodies) {
		assert.equal(body.meta.name, 'sidebar.right.tab.document');
		assert.equal(body.meta.locale, 'previewEditor');
	}
	assert.deepEqual(
		registered.bodies.map((body) => body.meta.key),
		registered.definitions.map((entry) => entry.id),
		'each renderer needs its own keyed body'
	);
	assert.equal(registered.dictionaries.length, 1);
	// Keys must be flat and dotted. The locale runtime resolves `dict[key]` in one
	// step and falls back to the key itself, so a nested dictionary puts raw keys
	// like `viewer.label` in the viewer menu.
	const [{ namespace, dictionaries }] = registered.dictionaries;
	assert.equal(namespace, 'previewEditor');
	for (const locale of ['zh', 'en']) {
		for (const [key, value] of Object.entries(dictionaries[locale])) {
			assert.equal(typeof value, 'string', `${locale}["${key}"] must be a flat string`);
		}
	}
	assert.deepEqual(
		Object.keys(dictionaries.en).sort(),
		Object.keys(dictionaries.zh).sort(),
		'both locales must define the same keys'
	);
	assert.equal(dictionaries.zh['viewer.label'], 'Edit');
	assert.equal(dictionaries.en['viewer.label'], 'Edit');
});

await test('every key the client translates exists in both flat dictionaries', async () => {
	const { registered } = await clientHarness(undefined);
	// The keys come out of the bundle's own source, so a new `t('...')` call without
	// a dictionary entry fails here instead of reaching the interface.
	const source = await fs.readFile(path.join(here, 'client.js'), 'utf8');
	const asked = [...new Set([...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]))];
	assert.ok(asked.length > 15, `expected the body to translate more keys, saw ${asked.length}`);
	const [{ dictionaries }] = registered.dictionaries;
	for (const locale of ['zh', 'en']) {
		for (const key of asked) {
			assert.equal(typeof dictionaries[locale][key], 'string', `${locale} is missing "${key}"`);
			assert.notEqual(dictionaries[locale][key], key, `${locale}["${key}"] resolves to its own key`);
		}
	}
});

await test('the viewer-menu label resolves instead of leaking its key', async () => {
	const { registered } = await clientHarness(undefined);
	assert.equal(registered.definitions.length, 2, 'both renderers must register');
	for (const definition of registered.definitions) {
		assert.equal(definition.title(), 'Edit', 'the viewer menu must show a readable label');
	}
});

await test('editableAsDefault restores Edit as the first viewer', async () => {
	const { registered } = await clientHarness({ editableAsDefault: true });
	assert.equal(registered.definitions.length, 2);
	for (const definition of registered.definitions) {
		assert.equal(definition.priority, 'extension', `${definition.id} must outrank the builtin band again`);
	}
	// The default (no config) is the opposite: both bands are builtin.
	const plain = await clientHarness(undefined);
	assert.deepEqual(
		plain.registered.definitions.map((entry) => entry.priority),
		['builtin', 'builtin'],
		'without the switch Edit must sit in the builtin band, not outrank it'
	);
});

await test('Edit is registered so the shipped plain-text row stays below it', async () => {
	// The owner builds `candidates = [...matched, plainText]` and appends its
	// plain-text fallback unconditionally, so "Plain text" is always the last menu
	// row no matter which band this plugin uses. What this plugin CAN guarantee is
	// that Edit lands in the last position among the matched viewers: it registers
	// after every shipped definition and in the same (or a lower) band, so the
	// registration-order tiebreak puts it last. This test pins that invariant so a
	// future `extension`-band regression cannot quietly jump Edit up the menu.
	const { registered } = await clientHarness(undefined);
	assert.deepEqual(
		registered.definitions.map((entry) => entry.id),
		['@local/dsh-preview-editor/text', '@local/dsh-preview-editor/markdown'],
		'registration order decides the last matched slot'
	);
	for (const definition of registered.definitions) {
		assert.equal(
			definition.priority,
			'builtin',
			`${definition.id} must not outrank the shipped viewers`
		);
	}
});
await test('config replaces the suffixes and only chooses which Markdown view comes first', async () => {
	const { registered } = await clientHarness({
		extensions: ['.TS', 'py'],
		markdown: false,
		maxBytes: 2048
	});
	assert.deepEqual(list(registered.definitions[0].extensions), ['ts', 'py']);
	// `markdown: false` only chooses which view opens first inside the editor;
	// the priority band is unchanged (builtin), so the shipped rendered preview
	// stays the default for files whose tab has not selected Edit.
	assert.equal(registered.definitions[1].priority, 'builtin');
	assert.ok(registered.definitions[1].extensions.includes('md'));

	// An explicit false starts the body on the rendered view, with 编辑 one click
	// away — the preference the earlier revision shipped as "rendered by default".
	const text = '# Title\n';
	const nodes = await renderReady('dsh-resource://file/session/s1/README.md', {
		primitives: primitivesStub(),
		text,
		config: { markdown: false }
	});
	assert.equal(
		nodes.find((node) => node.type === 'textarea'),
		undefined,
		'markdown: false must open on the rendered view'
	);
	assert.equal(
		nodes.find((node) => node.props?.['data-markdown-text'] !== undefined).props['data-markdown-text'],
		text
	);
	assert.ok(nodes.some((node) => node.props?.['data-preview-editor-toggle'] === 'edit'));
});

// ── Client: render smoke test ───────────────────────────────────────────────

await test('the body renders a textarea over the loaded text', async () => {
	const { client, registered } = await clientHarness(undefined, {
		seed: [
			{
				status: 'ready',
				text: 'alpha\nbeta',
				baseline: 'alpha\nbeta',
				version: 'h:1',
				eol: '\n',
				path: 'C:/w/alpha.txt',
				saving: false
			}
		]
	});
	const tree = client.EditorBody({
		content: { kind: 'renderer', revision: 1, loaded() {}, failed() {}, reload() {} },
		useTabInfo: () => ({ tab: { id: 't1', contentId: 'dsh-resource://file/session/s1/alpha.txt' } }),
		resourceAddress: 'dsh-resource://file/session/s1/alpha.txt',
		t: registered.translate
	});
	const nodes = elements(tree);
	const textarea = nodes.find((node) => node.type === 'textarea');
	assert.ok(textarea !== undefined, 'no textarea was rendered');
	assert.equal(textarea.props.value, 'alpha\nbeta');
	const buttons = nodes.filter((node) => node.type === 'button').map((node) => node.props.disabled);
	assert.deepEqual(buttons, [undefined, true], 'the save button should be disabled while clean');
});

await test('the initial loading state renders a visible pane instead of throwing', async () => {
	// Regression for the blank-Edit bug: the first render has `{status:'loading'}`
	// and NO `text`. `rowCount(undefined)` used to throw, which aborted the render
	// before React could commit the effect that starts the read — the pane then
	// stayed empty forever. No seed means useState falls back to its initial value,
	// reproducing exactly that first render.
	const { client, registered } = await clientHarness(undefined);
	const tree = client.EditorBody({
		content: { kind: 'renderer', revision: 1, loaded() {}, failed() {}, reload() {} },
		useTabInfo: () => ({ tab: { id: 't1', contentId: 'dsh-resource://file/session/s1/a.txt' } }),
		resourceAddress: 'dsh-resource://file/session/s1/a.txt',
		t: registered.translate
	});
	const nodes = elements(tree);
	const loading = nodes.find((node) => node.props?.['data-preview-editor'] === 'loading');
	assert.ok(loading !== undefined, 'the loading pane is missing');
	assert.ok(
		nodes.some((node) => node.props?.children === 'Loading…'),
		'the loading state must show a visible status'
	);
	assert.ok(
		!nodes.some((node) => node.type === 'textarea'),
		'a textarea must not exist before the text arrives'
	);
});

await test('the body renders its failure state with a retry', async () => {
	const { client, registered } = await clientHarness(undefined, {
		seed: [{ status: 'error', message: 'FS_NOT_TEXT' }]
	});
	const tree = client.EditorBody({
		content: { kind: 'renderer', revision: 1, loaded() {}, failed() {}, reload() {} },
		useTabInfo: () => ({ tab: { id: 't1', contentId: 'dsh-resource://file/session/s1/a.bin' } }),
		resourceAddress: 'dsh-resource://file/session/s1/a.bin',
		t: registered.translate
	});
	const nodes = elements(tree);
	assert.ok(nodes.some((node) => node.type === 'button'), 'no retry button was rendered');
	assert.ok(nodes.some((node) => node.type === 'p'), 'the failure message is missing');
});

// ── Client: the editing surface ─────────────────────────────────────────────

/**
 * Render the body in its ready state over one file.
 *
 * @param address - the resource address to render.
 * @param options - `primitives` and `config` for the client half, `text` for the
 *   loaded buffer, and `eol` for the line ending the read would have reported.
 * @returns every rendered element.
 */
async function renderReady(address, options = {}) {
	const text = options.text ?? 'const a = 1\nlet b = 2\n';
	const { client, registered } = await clientHarness(options.config, {
		seed: [
			{
				status: 'ready',
				text,
				baseline: text,
				version: 'v1',
				eol: options.eol ?? '\n',
				// The read op reports the absolute path; relative images resolve off it.
				path: options.path ?? address,
				saving: false
			},
			...(options.seed ?? [])
		],
		primitives: options.primitives,
		locale: options.locale
	});
	const tree = client.EditorBody({
		content: { kind: 'renderer', revision: 1, loaded() {}, failed() {}, reload() {} },
		useTabInfo: () => ({ tab: { id: 't1', contentId: address } }),
		resourceAddress: address,
		t: registered.translate
	});
	return elements(tree);
}

await test('a known language paints the layer under an invisible textarea', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub()
	});
	const layer = nodes.find((node) => node.props?.['data-preview-editor-highlight'] === true);
	assert.ok(layer !== undefined, 'no highlight layer was rendered');
	assert.equal(layer.type, 'pre');
	assert.equal(layer.props.className, 'shiki css-variables');
	assert.equal(layer.props['aria-hidden'], 'true');
	assert.equal(layer.props.style.whiteSpace, 'pre', 'a nowrap preview must not wrap the layer');

	const textarea = nodes.find((node) => node.type === 'textarea');
	assert.equal(textarea.props.value, 'const a = 1\nlet b = 2\n');
	assert.equal(textarea.props.style.color, 'transparent', 'the textarea must hide its own glyphs');
	assert.ok(textarea.props.style.caretColor !== undefined, 'the caret must stay visible');
	assert.equal(textarea.props.wrap, 'off');
	assert.equal(textarea.props.style.whiteSpace, 'pre');
	// Both layers are positioned, so DOM order decides the paint: the textarea is
	// lifted above the paint it is aligned with.
	assert.equal(layer.props.style.zIndex, 0);
	assert.equal(layer.props.style.pointerEvents, 'none');
	assert.equal(layer.props.style.background, 'transparent');
	assert.equal(textarea.props.style.zIndex, 1);
	assert.equal(textarea.props.style.position, 'relative');
	assert.equal(textarea.props.style.padding, layer.props.style.padding);
	assert.equal(textarea.props.style.fontFamily, layer.props.style.fontFamily);
	assert.equal(textarea.props.style.fontSize, layer.props.style.fontSize);
	assert.equal(textarea.props.style.lineHeight, layer.props.style.lineHeight);
	assert.equal(textarea.props.style.tabSize, layer.props.style.tabSize);

	// One painted row per buffer row — the trailing empty row included — each
	// carrying the highlighter's spans and the file's own line ending after them.
	const lines = nodes.filter((node) => node.props?.['data-preview-editor-line'] === true);
	assert.equal(lines.length, 3, 'expected one painted row per text row, the last one included');
	assert.deepEqual(
		lines.map((line) => line.props.children[0].props.children),
		['const a = 1', 'let b = 2', '\u200b']
	);
	assert.deepEqual(lines[0].props.children[0].props.style, {
		color: 'var(--shiki-token-keyword)'
	});

	// Every row ends with the mark for the file's line ending, and this file does
	// end with one, so even the last, empty row carries it.
	const ends = lines.map((line) => line.props.children.at(-1));
	assert.deepEqual(ends.map((span) => span.props.children), ['\u21b5', '\u21b5', '\u21b5']);
	assert.equal(ends[0].props.title, 'Line ending LF (U+000A)');
	assert.deepEqual(plain(ends[0].props.style), {
		color: 'rgba(214,145,0,.8)',
		pointerEvents: 'none',
		userSelect: 'none'
	});

	// Rows are separated by real newlines, and the tokenizer's dropped trailing
	// empty line is a row of its own rather than a spacer on the line above.
	const children = layer.props.children;
	assert.equal(children.length, 5, 'three rows and the two newlines between them');
	assert.deepEqual(
		plain(children.map((child) => (typeof child === 'string' ? child : 'row'))),
		['row', '\n', 'row', '\n', 'row']
	);
	assert.deepEqual(plain(children.at(-1).props.children.map((span) => span.props.children)), ['\u200b', '\u21b5']);
});

await test('the layer follows the textarea when the preview wraps', async () => {
	const text = 'const a = 1\nlet b = 2';
	const { client } = await clientHarness(undefined, {
		seed: [
			{
				status: 'ready',
				text,
				baseline: text,
				version: 'v1',
				eol: '\n',
				path: 'C:/w/alpha.ts',
				saving: false
			}
		],
		primitives: primitivesStub()
	});
	const tree = client.EditorBody({
		content: { kind: 'renderer', revision: 1, loaded() {}, failed() {}, reload() {} },
		useTabInfo: () => ({ tab: { id: 't1', contentId: 'dsh-resource://file/session/s1/alpha.ts' } }),
		resourceAddress: 'dsh-resource://file/session/s1/alpha.ts',
		wrap: true,
		t: (key) => key
	});
	const nodes = elements(tree);
	const layer = nodes.find((node) => node.props?.['data-preview-editor-highlight'] === true);
	const textarea = nodes.find((node) => node.type === 'textarea');
	assert.equal(layer.props.style.whiteSpace, 'pre-wrap');
	assert.equal(textarea.props.style.whiteSpace, 'pre-wrap');
	assert.equal(textarea.props.wrap, 'soft');
});

await test('an unknown language stays plain and the bar says why', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/notes.txt', {
		primitives: primitivesStub({ languages: { ts: 'typescript' } })
	});
	assert.ok(
		!nodes.some((node) => node.props?.['data-preview-editor-highlight'] === true),
		'the layer must not render without tokens'
	);
	// The marks still need a painted copy of the buffer, so the plain layer takes
	// the place of the highlighted one and the textarea hides its own glyphs.
	const paint = nodes.find((node) => node.props?.['data-preview-editor-layer'] === 'plain');
	assert.ok(paint !== undefined, 'the plain paint layer is missing');
	assert.deepEqual(
		plain(
			paint.props.children.map((child) =>
				typeof child === 'string' ? child : child.props.children[0].props.children
			)
		),
		['const a = 1', '\n', 'let b = 2', '\n', '\u200b']
	);
	const textarea = nodes.find((node) => node.type === 'textarea');
	assert.equal(textarea.props.style.color, 'transparent', 'the painted copy carries the glyphs');
	assert.ok(
		nodes.some((node) => node.props?.children === 'plain'),
		'the plain-text hint is missing'
	);
});

await test('a buffer over the highlight cap stays plain while the editor still loads', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		config: { highlightMaxBytes: 8 },
		text: 'const a = 1\nlet b = 2\n'
	});
	assert.ok(
		!nodes.some((node) => node.props?.['data-preview-editor-highlight'] === true),
		'a capped buffer must not be tokenized'
	);
	const textarea = nodes.find((node) => node.type === 'textarea');
	assert.equal(textarea.props.value, 'const a = 1\nlet b = 2\n', 'the buffer must survive the cap');
	assert.ok(nodes.some((node) => node.props?.children === 'plain'));
});

await test('the host config can turn highlighting off entirely', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		config: { highlight: false }
	});
	assert.ok(
		!nodes.some((node) => node.props?.['data-preview-editor-highlight'] === true),
		'highlighting was disabled but a layer rendered'
	);
	assert.ok(
		!nodes.some((node) => node.props?.children === 'plain'),
		'an explicit off switch must not warn'
	);
	// Off means no tokens and no colours; the marks are a separate switch, so the
	// plain layer is still painted and still hides the textarea's own glyphs.
	assert.ok(
		nodes.some((node) => node.props?.['data-preview-editor-layer'] === 'plain'),
		'disabling highlighting must not disable the marks'
	);
	assert.equal(
		nodes.find((node) => node.type === 'textarea').props.style.color,
		'transparent'
	);
});

await test('the gutter numbers every row beside the textarea', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub()
	});
	const gutter = nodes.find((node) => node.props?.['data-preview-editor-gutter'] === true);
	assert.ok(gutter !== undefined, 'no gutter was rendered');
	// A sibling of the editor, never a child of it: the numbers cannot be copied
	// with the text, and a click beside a line still reaches the textarea.
	assert.equal(
		elements(gutter).some((node) => node.type === 'textarea'),
		false,
		'the gutter must not wrap the textarea'
	);
	assert.equal(gutter.props['aria-hidden'], 'true');
	assert.equal(gutter.props.style.pointerEvents, 'none');
	assert.equal(gutter.props.style.userSelect, 'none');
	assert.equal(gutter.props.style.overflow, 'hidden');
	assert.equal(gutter.props.style.width, '3ch');
	// One row per text row, at the fallback line tops: no layout exists here, so
	// the rows fall back to the line height the editor's own font settings produce.
	const rows = elements(gutter).filter((node) => node.props?.style?.top !== undefined);
	assert.deepEqual(rows.map((row) => row.props.children), [1, 2, 3]);
	assert.deepEqual(rows.map((row) => row.props.style.top), ['8px', '26.6px', '45.2px']);
	assert.deepEqual(rows.map((row) => row.props.style.height), ['18.6px', '18.6px', '18.6px']);
});

await test('invisible characters are marked in place and plain spaces are not', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		text: 'a b \nc\u00a0d\n'
	});
	const rows = nodes.filter((node) => node.props?.['data-preview-editor-line'] === true);
	// A space in the middle of a line is just a space; only the run that trails the
	// line is marked, and it is marked without being replaced.
	assert.deepEqual(
		plain(rows[0].props.children.map((span) => [span.props.children, span.props.title ?? null])),
		[
			['a b', null],
			[' ', 'u+0020 trailing space'],
			['\u21b5', 'Line ending LF (U+000A)']
		]
	);
	assert.deepEqual(
		plain(rows[1].props.children.map((span) => [span.props.children, span.props.title ?? null])),
		[
			['c', null],
			['\u00a0', 'u+00A0 nbsp'],
			['d', null],
			['\u21b5', 'Line ending LF (U+000A)']
		]
	);
	// The band is painted inside the character's own box, over the token's colour
	// and never instead of the character.
	const marked = rows[1].props.children[1];
	assert.equal(marked.props.style.background, 'rgba(214,145,0,.2)');
	assert.equal(marked.props.style.boxShadow, 'inset 0 -1px 0 0 rgba(214,145,0,.85)');
	assert.equal(marked.props.style.color, 'var(--shiki-token-keyword)', 'the mark must not repaint the token');
});

await test('the end-of-line mark names the file\'s own line ending', async () => {
	// A read normalizes CRLF to LF while remembering the file's ending, so the mark
	// has to come from the remembered one rather than from the buffer.
	const crlf = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		text: 'a\nb\n',
		eol: '\r\n'
	});
	const rows = crlf.filter((node) => node.props?.['data-preview-editor-line'] === true);
	assert.deepEqual(
		rows.map((line) => line.props.children.at(-1).props.children),
		['\u23ce', '\u23ce', '\u23ce'],
		'a CRLF file must say CRLF'
	);
	assert.equal(rows[0].props.children.at(-1).props.title, 'Line ending CRLF (U+000D U+000A)');

	// A file whose last line has no ending at all says that instead, in the warning
	// colour, and only the last row does.
	const unterminated = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		text: 'a\nb'
	});
	const last = unterminated.filter((node) => node.props?.['data-preview-editor-line'] === true);
	assert.equal(last.length, 2, 'a buffer without a trailing newline shows no empty row');
	assert.deepEqual(last.map((line) => line.props.children.at(-1).props.children), ['\u21b5', '\u2205']);
	assert.equal(last[1].props.children.at(-1).props.title, 'No line ending at end of file');
	assert.equal(last[1].props.children.at(-1).props.style.color, 'rgba(220,70,70,.9)');
});

await test('the gutter and the marks are separately switchable', async () => {
	const noGutter = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		config: { lineNumbers: false }
	});
	assert.ok(
		!noGutter.some((node) => node.props?.['data-preview-editor-gutter'] === true),
		'the line numbers were switched off but a gutter rendered'
	);
	assert.ok(
		noGutter.some((node) => node.type === 'textarea'),
		'the editor must still render without its gutter'
	);

	const noMarks = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		config: { marks: false }
	});
	const layer = noMarks.find((node) => node.props?.['data-preview-editor-highlight'] === true);
	assert.ok(layer !== undefined, 'the highlighter still paints with the marks off');
	assert.equal(
		elements(layer).filter((node) => typeof node.props?.title === 'string' && node.props.title.startsWith('u+'))
			.length,
		0,
		'no character may be marked with the switch off'
	);

	// With no highlighter and no marks there is nothing to paint, so the textarea
	// keeps its own glyphs and no layer is mounted at all.
	const bare = await renderReady('dsh-resource://file/session/s1/notes.txt', {
		primitives: primitivesStub({ languages: { ts: 'typescript' } }),
		config: { marks: false }
	});
	assert.ok(
		!bare.some((node) => node.props?.['data-preview-editor-layer'] === 'plain'),
		'a plain buffer with no marks must not be painted twice'
	);
	assert.equal(
		bare.find((node) => node.type === 'textarea').props.style.color,
		'var(--dsw-alias-label-primary, inherit)'
	);
});

await test('a buffer over the mark cap stays unmarked while the editor still loads', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub(),
		config: { marksMaxBytes: 8 }
	});
	assert.equal(
		nodes.filter((node) => typeof node.props?.title === 'string' && node.props.title.startsWith('u+')).length,
		0,
		'a capped buffer must not be marked'
	);
	assert.equal(
		nodes.filter((node) => node.props?.['data-preview-editor-line'] === true).length,
		3,
		'the rows are still drawn, just unmarked'
	);
	assert.ok(
		nodes.some((node) => node.props?.children === 'no marks'),
		'the mark hint is missing'
	);
	assert.equal(
		nodes.find((node) => node.type === 'textarea').props.value,
		'const a = 1\nlet b = 2\n',
		'the buffer must survive the cap'
	);
});

await test('a shell without the primitives module still yields a working editor', async () => {
	const bare = await loadClient(reactShim());
	assert.equal(typeof bare.exports.EditorBody, 'function', 'a missing primitives module must not break the bundle');
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts');
	assert.ok(nodes.some((node) => node.type === 'textarea'), 'the plain editor must still render');
});

await test('a Markdown file opens editable and can show itself rendered', async () => {
	const text = '# Title\n\nbody\n';
	const editing = await renderReady('dsh-resource://file/session/s1/README.md', {
		primitives: primitivesStub(),
		text
	});
	const textarea = editing.find((node) => node.type === 'textarea');
	assert.ok(textarea !== undefined, 'a Markdown file must open in the editor');
	assert.equal(textarea.props.value, text);
	const toggle = editing.find((node) => node.props?.['data-preview-editor-toggle'] === 'preview');
	assert.ok(toggle !== undefined, 'the preview toggle is missing for a Markdown file');
	assert.equal(toggle.props.children, 'Preview');

	// The rendered view is this body's own, so it does not depend on the viewer
	// menu working, and it renders the buffer rather than the file on disk.
	const rendered = await renderReady('dsh-resource://file/session/s1/README.md', {
		primitives: primitivesStub(),
		text,
		seed: [true]
	});
	assert.equal(
		rendered.find((node) => node.type === 'textarea'),
		undefined,
		'the rendered view must replace the editor'
	);
	const markdown = rendered.find((node) => node.props?.['data-markdown-text'] !== undefined);
	assert.equal(markdown.props['data-markdown-text'], text, 'the buffer must be rendered verbatim');
	assert.equal(
		markdown.props['data-markdown-labels'].code.copyLabel,
		'Copy',
		'the renderer needs its code-block labels'
	);
	assert.equal(
		rendered.find((node) => node.props?.['data-preview-editor-toggle'] === 'edit').props.children,
		'Edit'
	);
	// Saving stays reachable while the textarea is not mounted.
	assert.ok(rendered.some((node) => node.type === 'button' && node.props.children === 'Save'));
});

await test('the rendered view frames frontmatter and resolves relative images', async () => {
	const text = '---\ntitle: notes\ntags: [a, b]\n---\n\n# Heading\n\n![shot](img/a.png)\n';
	const nodes = await renderReady('dsh-resource://file/session/s1/notes/README.md', {
		primitives: primitivesStub(),
		text,
		path: 'C:/w/notes/README.md',
		seed: [true]
	});
	const framed = nodes.find((node) => node.props?.['data-preview-editor-frontmatter'] === true);
	assert.ok(framed !== undefined, 'the frontmatter block must be framed');
	assert.equal(
		nodes.find((node) => node.type === 'pre' && node.props.children === 'title: notes\ntags: [a, b]').props
			.children,
		'title: notes\ntags: [a, b]'
	);
	const markdown = nodes.find((node) => node.props?.['data-markdown-text'] !== undefined);
	assert.equal(markdown.props['data-markdown-text'], '\n# Heading\n\n![shot](img/a.png)\n');
	const resolve = markdown.props['data-markdown-path-images'].resolve;
	assert.equal(
		resolve('img/a.png'),
		`http://127.0.0.1:57356/api/file?path=${encodeURIComponent('C:/w/notes/img/a.png')}`,
		'relative destinations must hang off the document directory'
	);
	assert.equal(
		resolve('C:/other/b.png'),
		`http://127.0.0.1:57356/api/file?path=${encodeURIComponent('C:/other/b.png')}`
	);
	assert.equal(resolve('https://example.com/c.png'), undefined, 'a remote destination is left alone');
	assert.equal(resolve(''), undefined);

	// Markdown without frontmatter renders as one body, with nothing framed.
	const plain = await renderReady('dsh-resource://file/session/s1/README.md', {
		primitives: primitivesStub(),
		text: '# Heading\n',
		path: 'C:/w/README.md',
		seed: [true]
	});
	assert.equal(plain.find((node) => node.props?.['data-preview-editor-frontmatter'] !== undefined), undefined);
	assert.equal(
		plain.find((node) => node.props?.['data-markdown-text'] !== undefined).props['data-markdown-text'],
		'# Heading\n'
	);
});

await test('a non-Markdown file offers no preview toggle', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/alpha.ts', {
		primitives: primitivesStub()
	});
	assert.equal(
		nodes.find((node) => node.props?.['data-preview-editor-toggle'] !== undefined),
		undefined
	);
});

await test('a shell without a Markdown renderer says so instead of drawing nothing', async () => {
	const nodes = await renderReady('dsh-resource://file/session/s1/README.md', {
		primitives: primitivesStub({ noMarkdown: true }),
		text: '# Title\n',
		seed: [true]
	});
	const rendered = nodes.find((node) => node.props?.['data-preview-editor-markdown'] === true);
	assert.ok(rendered !== undefined, 'the rendered view must still mount');
	assert.ok(
		nodes.some(
			(node) => node.type === 'p' && node.props.children === 'This shell provides no Markdown renderer.'
		),
		'the missing renderer must be reported'
	);
});

await test('a non-session address is refused instead of guessed', async () => {
	const { exports: client } = await loadClient(
		reactShim([{ status: 'error', message: 'error.address' }])
	);
	const tree = client.EditorBody({
		content: { kind: 'renderer', revision: 1, loaded() {}, failed() {}, reload() {} },
		useTabInfo: () => ({ tab: { id: 't2', contentId: 'dsh-resource://file/absolute/C:/w/a.txt' } }),
		resourceAddress: 'dsh-resource://file/absolute/C:/w/a.txt',
		t: (key) => key
	});
	assert.ok(elements(tree).length > 0);
});

// ── Report ─────────────────────────────────────────────────────────────────

await fs.rm(root, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
	console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}`);
	if (!entry.ok) console.log(`      ${entry.detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;