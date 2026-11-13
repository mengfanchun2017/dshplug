/**
 * In-place editing for the right Sidebar's document preview.
 *
 * The Client half renders an editor body and moves text through one exact Fetch
 * route claimed on the Connection `/api` bridge. That bridge already carries the
 * shipped browser authentication and the Host/Origin fence, so no second
 * credential scheme is invented and every request speaks for the browser's owner
 * Peer.
 *
 * Writes do not bypass the sandbox. The route resolves the requesting Session
 * and hands `ctx.fs` that Session's standing sandbox policy, exactly as the
 * shipped file tools do: a `workspace-write` Session can edit what its own tools
 * may write, `read-only` refuses, and `danger-full-access` is unfenced. Saves are
 * guarded by the target's observed version, so a file changed elsewhere fails
 * with `FS_STALE_VERSION` instead of being overwritten.
 *
 * @module @local/dsh-preview-editor
 */

/** Stable Cordis plugin name. */
export const name = 'preview-editor';

/**
 * The filesystem service is the only hard dependency. `connection` carries the
 * `/api` bridge, `sandboxPolicy` supplies the Session's write envelope, and
 * `sessions` names the requesting Session; the route is claimed only when all
 * three are present, because a route without them could not honour the sandbox.
 */
export const inject = ['fs'];

/** Exact Fetch route claimed on the Connection `/api` bridge. */
const ROUTE_PATH = '/api/dsh-preview-editor';

/**
 * Page global carrying this row's settings to the browser half.
 *
 * The client boot graph carries each bundle's identity, ordering, and
 * externals, but not its config, so the browser half can never read this row's
 * `config` through Cordis. The shipped preview packages bridge that the same
 * way: the Host half embeds the settings in the page, and the Client half reads
 * the global before registering.
 */
const CLIENT_CONFIG_GLOBAL = '__DSH_PREVIEW_EDITOR_CONFIG__';

/** Byte cap on one read or save, unless the profile config raises it. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Bound one JSON body so a request cannot exhaust memory before it is rejected.
 * The Connection bridge already buffers the body; this is the semantic cap.
 */
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * Resolve config without a schema: a plugin that exports no `Config` receives
 * its authoring config unchanged, so validation and defaults live here.
 *
 * `raw` is carried through untouched because the browser half owns the meaning
 * of `extensions` and `markdown`; this half only needs the caps.
 *
 * @param config - the row config from the profile patch, when present.
 * @returns validated caps for this deployment, plus the raw settings.
 */
function resolveConfig(config) {
	const raw = config === undefined || config === null ? {} : config;
	const maxBytes =
		Number.isSafeInteger(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : DEFAULT_MAX_BYTES;
	const maxRequestBytes =
		Number.isSafeInteger(raw.maxRequestBytes) && raw.maxRequestBytes > 0
			? raw.maxRequestBytes
			: DEFAULT_MAX_REQUEST_BYTES;
	return { raw, maxBytes, maxRequestBytes };
}

/**
 * Answer one JSON request with the given body.
 *
 * @param body - JSON-serializable reply.
 * @param status - HTTP status; refusals keep 200 so the Client reads the code.
 * @returns the Fetch response.
 */
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/**
 * Report a failure in the shape the Client switches on.
 *
 * @param error - the thrown value, usually an `FsError`.
 * @returns the JSON reply.
 */
function failure(error) {
	const code = typeof error?.code === 'string' ? error.code : undefined;
	const message = typeof error?.message === 'string' ? error.message : String(error);
	return json({ ok: false, code: code ?? 'error', message });
}

/**
 * Claim the exact Fetch route for this deployment.
 *
 * @param ctx - Host plugin context, already carrying `fs`.
 * @param config - row config from the profile patch.
 */
export function apply(ctx, config) {
	const cfg = resolveConfig(config);
	// The browser half cannot read this row's config through Cordis, so the
	// settings travel in the page instead; the webserver renders this row into
	// every index response.
	ctx.on('webserver/index-inject', (table) => {
		table.push({ kind: 'global', name: CLIENT_CONFIG_GLOBAL, value: cfg.raw });
	});
	ctx.inject(['connection', 'sandboxPolicy', 'sessions'], (scope) => {
		// `register` returns the owning effect, so the route leaves with this scope.
		scope.connection.fetch.register({
			path: ROUTE_PATH,
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: (request) => handle(scope, cfg, request)
		});
		scope.logger?.info?.(`preview-editor: editing bridge claimed at ${ROUTE_PATH}`);
	});
}

/**
 * Resolve one Session's filesystem target and standing sandbox policy.
 *
 * A cold or unknown Session is refused rather than guessed: the fallback policy
 * belongs to the deployment, not to the workspace the preview is showing.
 *
 * @param ctx - scope carrying `fs`, `sandboxPolicy`, and `sessions`.
 * @param sessionId - the Session named by the Client.
 * @param path - workspace-relative or absolute path.
 * @param signal - request aborts.
 * @returns the resolved target and policy, or a refusal reply.
 */
async function targetFor(ctx, sessionId, path, signal) {
	const session = ctx.sessions.get(sessionId);
	if (session === undefined) {
		return {
			reply: json({
				ok: false,
				code: 'FS_NO_SESSION',
				message: `session ${sessionId} is not live in this process`
			})
		};
	}
	const cwd = session.header?.cwd;
	// Resolving against the Session's workspace root is what the shipped
	// workspace-files API does for the very paths this Sidebar shows, so a
	// relative path means the same file to both.
	const policy = ctx.sandboxPolicy.resolve({ session });
	const target = await ctx.fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal });
	return { session, target, policy };
}

/**
 * Resolve the absolute spelling of a target for display, when the backend
 * exposes one.
 *
 * @param ctx - scope carrying `fs`.
 * @param target - the resolved target.
 * @returns the absolute path, or undefined.
 */
function absolutePathOf(ctx, target) {
	try {
		return typeof ctx.fs.processPath === 'function' ? ctx.fs.processPath(target) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read a whole file as text, with the observed version the Client echoes back on
 * save.
 *
 * @param ctx - scope carrying `fs`.
 * @param cfg - resolved caps.
 * @param target - the resolved target.
 * @param signal - request aborts.
 * @returns the JSON reply.
 */
async function read(ctx, cfg, target, signal) {
	// Reads take no policy: the sandbox backend gates mutations only, exactly as
	// the shipped read tool relies on.
	const stat = await ctx.fs.stat(target, signal);
	if (stat === undefined) {
		return json({ ok: false, code: 'FS_NOT_FOUND', message: 'the file no longer exists' });
	}
	if (stat.type !== 'file') {
		return json({ ok: false, code: 'FS_NOT_REGULAR_FILE', message: 'not a regular file' });
	}
	if (Number.isSafeInteger(stat.size) && stat.size > cfg.maxBytes) {
		return json({
			ok: false,
			code: 'FS_TOO_LARGE',
			message: `${stat.size} bytes exceeds the ${cfg.maxBytes}-byte editing limit`
		});
	}
	const text = await ctx.fs.readText(target, signal);
	return json({
		ok: true,
		text: typeof text === 'string' ? text : text?.text,
		version: stat.version,
		size: stat.size,
		absolutePath: absolutePathOf(ctx, target)
	});
}

/**
 * Write edited text back through the Session's own sandbox policy.
 *
 * @param ctx - scope carrying `fs`.
 * @param cfg - resolved caps.
 * @param target - the resolved target.
 * @param policy - the Session's sandbox policy.
 * @param content - the edited text.
 * @param version - the version observed when the text was read.
 * @param signal - request aborts.
 * @returns the JSON reply.
 */
async function save(ctx, cfg, target, policy, content, version, signal) {
	if (Buffer.byteLength(content, 'utf8') > cfg.maxBytes) {
		return json({
			ok: false,
			code: 'FS_TOO_LARGE',
			message: `the edited text exceeds the ${cfg.maxBytes}-byte editing limit`
		});
	}
	// `replaceIfVersion` is the guard the shipped editors use: a changed file
	// fails instead of being silently clobbered.
	const expected = typeof version === 'string' ? { kind: 'replaceIfVersion', version } : undefined;
	const written = await ctx.fs.writeText(target, content, expected, signal, policy);
	return json({
		ok: true,
		version: written?.version,
		operation: written?.operation
	});
}

/**
 * Handle one request on the editing route.
 *
 * @param ctx - scope carrying the Host services.
 * @param cfg - resolved caps.
 * @param request - the buffered Fetch request.
 * @returns the JSON reply.
 */
async function handle(ctx, cfg, request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, code: 'E_BAD_REQUEST', message: 'the request body must be JSON' });
	}
	const op = typeof body?.op === 'string' ? body.op : undefined;
	const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
	const path = typeof body?.path === 'string' && body.path.length > 0 ? body.path : undefined;
	if (sessionId === undefined || path === undefined) {
		return json({
			ok: false,
			code: 'E_BAD_REQUEST',
			message: 'sessionId and path are required'
		});
	}
	const signal = request.signal ?? undefined;
	let resolved;
	try {
		resolved = await targetFor(ctx, sessionId, path, signal);
	} catch (error) {
		return failure(error);
	}
	if (resolved.reply !== undefined) return resolved.reply;
	try {
		if (op === 'read') {
			return await read(ctx, cfg, resolved.target, signal);
		}
		if (op === 'save') {
			if (typeof body.text !== 'string') {
				return json({ ok: false, code: 'E_BAD_REQUEST', message: 'text must be a string' });
			}
			return await save(
				ctx,
				cfg,
				resolved.target,
				resolved.policy,
				body.text,
				body.version,
				signal
			);
		}
		return json({ ok: false, code: 'E_BAD_REQUEST', message: `unknown op ${String(op)}` });
	} catch (error) {
		return failure(error);
	}
}