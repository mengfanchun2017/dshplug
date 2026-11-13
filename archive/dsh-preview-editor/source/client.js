/**
 * Client half of `@local/dsh-preview-editor`.
 *
 * This hand-written bundle registers a document-preview renderer ("编辑器") whose
 * body shows an invisible textarea over the file's exact text, with the platform
 * highlighter's colours painted in a layer beneath it, and saves the buffer back
 * through the Host route claimed on the Connection `/api` bridge. The body
 * speaks the documented renderer contract: it reads for itself, reports
 * `loaded(version)` / `failed()` to the preview owner, and reloads when the
 * owner bumps `content.revision`.
 *
 * Text travels with its line endings intact: the buffer holds `LF`, the file's
 * dominant ending is remembered, and the save restores it, so a CRLF file does
 * not silently become an LF file.
 *
 * @module @local/dsh-preview-editor/client
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-preview-editor',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		/**
		* The platform's highlighter and language table. Highlighting is a bonus, so
		* an absent or reshaped module degrades to the plain editor rather than
		* taking the whole renderer down with it.
		*/
		let primitives;
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		} catch {
			primitives = undefined;
		}

		/** Stable Cordis plugin name, matching the Host half. */
		const name = 'preview-editor';

		/** Renderer identity; also the keyed body's slot key. */
		const EDITOR_ID = '@local/dsh-preview-editor/text';

		/** Renderer identity for Markdown, kept separate so its rank can differ. */
		const MARKDOWN_EDITOR_ID = '@local/dsh-preview-editor/markdown';

		/** The exact Host route carrying reads and saves. */
		const ROUTE_PATH = '/api/dsh-preview-editor';

		/** Runtime-strings namespace for this plugin's body. */
		const LOCALE_NS = 'previewEditor';

		/** Byte cap mirroring the Host default. */
		const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

		/**
		* Default byte cap for highlighting.
		*
		* Tokenizing runs synchronously on the main thread, so a large file trades
		* typing latency for colour; past this size the editor stays plain text.
		*/
		const DEFAULT_HIGHLIGHT_MAX_BYTES = 256 * 1024;

		/**
		* Default byte cap for the line-number gutter and the invisible-character marks.
		*
		* The marks are painted by splitting every line into marked and unmarked runs,
		* and the gutter measures the painted line boxes; the same reasoning as
		* highlighting applies with a lower ceiling, because past this size the editor
		* keeps the textarea's own text and drops both.
		*/
		const DEFAULT_MARKS_MAX_BYTES = 256 * 1024;

		/**
		* The editor's own font metrics, in one place.
		*
		* The gutter has to reproduce the textarea's line boxes exactly, so its rows
		* are built from these numbers rather than from a second copy of the CSS.
		*/
		const EDITOR_FONT_SIZE = 12;
		const EDITOR_LINE_HEIGHT = 1.55;
		/** One line box, in CSS pixels: `12px` at `1.55`. */
		const LINE_HEIGHT_PX = EDITOR_FONT_SIZE * EDITOR_LINE_HEIGHT;
		/** Top padding the textarea and the paint layer share. */
		const EDITOR_PAD_TOP = 8;
		/** Left padding the textarea and the paint layer share. */
		const EDITOR_PAD_LEFT = 10;
		const EDITOR_MONOSPACE = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

		/** Suffixes that open in the editor, unless the profile config replaces them. */
		const DEFAULT_EXTENSIONS = [
			'txt', 'text', 'log', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
			'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
			'editorconfig', 'gitignore', 'gitattributes', 'csv', 'tsv',
			'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
			'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm', 'xhtml', 'xml', 'svg',
			'vue', 'svelte', 'astro',
			'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'clj',
			'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'php', 'pl', 'lua', 'r', 'jl',
			'dart', 'swift', 'm', 'mm', 'gradle', 'groovy',
			'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
			'sql', 'graphql', 'gql', 'proto', 'tf', 'hcl', 'nix',
			'patch', 'diff', 'tex', 'bib', 'rst', 'adoc', 'asciidoc',
			'ex', 'exs', 'erl', 'hs', 'ml', 'zig', 'nim', 'vim', 'el'
		];

		/**
		* Markdown suffixes.
		*
		* The built-in Markdown preview claims `md` and `markdown`, and the registry
		* ranks a non-`builtin` definition above every `builtin` one. So the editor
		* cannot both claim those suffixes and let the rendered preview stay the
		* default: that is a priority choice, not an extension-list choice. This
		* definition therefore mirrors that: `markdown: true` claims them as a normal
		* extension (editor by default), and otherwise registers as `builtin`, which
		* ties with the Markdown preview and loses only on registration order — the
		* preview keeps the default and the editor sits beside it in the viewer menu.
		* `mdx`/`mdown`/`mkd` have no built-in preview, so they open in the editor
		* either way.
		*/
		const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx', 'mdown', 'mkd'];

		/**
		* The resolved byte cap the body warns about; `apply` sets it from config so
		* the body can refuse an oversized save before the Host does.
		*/
		let editingMaxBytes = DEFAULT_MAX_BYTES;

		/** The resolved highlighting switch and cap; `apply` sets it from config. */
		let editingHighlight = { enabled: true, maxBytes: DEFAULT_HIGHLIGHT_MAX_BYTES };

		/** The resolved mark switch and cap; `apply` sets them from config. */
		let editingMarks = { enabled: true, maxBytes: DEFAULT_MARKS_MAX_BYTES };

		/** Whether the editor draws its line-number gutter; `apply` sets it. */
		let editingLineNumbers = true;

		/**
		* Whether a Markdown file opens on its rendered view instead of the buffer;
		* `apply` sets it from config.
		*/
		let editingMarkdownFirst = false;

		/**
		* Resolve the row config with the same defaults the Host half applies.
		*
		* @param config - the row config, when the client half receives it.
		* @returns the code suffix list, the markdown suffix list with its priority,
		*   the highlighting switch and cap, the mark switch and cap, the line-number
		*   switch, and the byte cap.
		*/
		function resolveConfig(config) {
			const raw = config === undefined || config === null ? {} : config;
			const declared = Array.isArray(raw.extensions)
				? raw.extensions.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
				: undefined;
			const base = declared === undefined ? DEFAULT_EXTENSIONS : declared;
			const normalize = (entry) => entry.replace(/^\./, '').toLowerCase();
			// Every shipped viewer registers in the `builtin` band, and the registry
			// keeps registration order inside a band. Registering there — after the
			// shipped packages — leaves Code / Text / Markdown as the default and puts
			// Edit last in the viewer menu. `editableAsDefault: true` restores the old
			// `extension` band for anyone who wants Edit first.
			return {
				extensions: base.map(normalize),
				markdown: {
					extensions: MARKDOWN_EXTENSIONS.slice(),
					priority: raw.editableAsDefault === true ? 'extension' : 'builtin',
					first: raw.markdown === false
				},
				highlight: raw.highlight !== false,
				highlightMaxBytes:
					Number.isSafeInteger(raw.highlightMaxBytes) && raw.highlightMaxBytes > 0
						? raw.highlightMaxBytes
						: DEFAULT_HIGHLIGHT_MAX_BYTES,
				marks: raw.marks !== false,
				marksMaxBytes:
					Number.isSafeInteger(raw.marksMaxBytes) && raw.marksMaxBytes > 0
						? raw.marksMaxBytes
						: DEFAULT_MARKS_MAX_BYTES,
				lineNumbers: raw.lineNumbers !== false,
				editableAsDefault: raw.editableAsDefault === true,
				maxBytes:
					Number.isSafeInteger(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : DEFAULT_MAX_BYTES
			};
		}

		/**
		* Namespaces of every runtime string this body renders.
		*
		* Keys are **flat and dotted** (`'action.save'`, never `{ action: { save } }`).
		* The locale runtime looks a key up as one verbatim property of the namespace
		* dictionary (`locales.get(active)?.[key]`) and finally falls back to showing
		* the key itself. A nested object therefore never matches, and every string
		* renders as its own key — `viewer.label` in the viewer menu, `action.save` on
		* the save button. The shipped renderers use the same flat shape.
		*
		* @returns the dictionary pair handed to `ctx.locale.register`.
		*/
		function dictionaries() {
			return {
				zh: {
					// The implementation name shown in the viewer menu. Kept
					// language-neutral, as the shipped renderers label themselves
					// ("Markdown", "Image").
					'viewer.label': 'Edit',
					'action.save': '保存',
					'action.reload': '重新载入',
					'action.retry': '重试',
					'action.preview': '预览',
					'action.edit': '编辑',
					'code.copy': '复制',
					'code.copied': '已复制',
					'codeBlock.title': '代码',
					'codeBlock.wrap': '换行',
					'codeBlock.unwrap': '不换行',
					footnotes: '脚注',
					'status.loading': '读取中…',
					'status.clean': '已保存',
					'status.dirty': '未保存',
					'status.saving': '保存中…',
					'status.saved': '已保存',
					'status.stale': '文件已被外部修改',
					'status.failed': '保存失败',
					'error.address': '这个预览项没有指向可编辑的会话文件。',
					'error.tooLarge': '文件超过编辑器的大小上限。',
					'error.noPreview': '这个外壳没有提供 Markdown 渲染组件。',
					'hint.noHighlight': '无高亮',
					'hint.noHighlightWhy': '未高亮：文件超过高亮上限，或这个语言不在平台高亮表里。',
					'hint.noMarks': '无标记',
					'hint.noMarksWhy': '未标记不可见字符：文件超过标记上限。',
					// The end-of-line mark's tooltip names the bytes, so a CRLF file says
					// so instead of leaving the reader to guess from the glyph.
					'marks.eolLf': '换行 LF（U+000A）',
					'marks.eolCrlf': '换行 CRLF（U+000D U+000A）',
					'marks.noEol': '文件末尾没有换行',
					shortcut: 'Ctrl+S 保存'
				},
				en: {
					'viewer.label': 'Edit',
					'action.save': 'Save',
					'action.reload': 'Reload',
					'action.retry': 'Retry',
					'action.preview': 'Preview',
					'action.edit': 'Edit',
					'code.copy': 'Copy',
					'code.copied': 'Copied',
					'codeBlock.title': 'Code',
					'codeBlock.wrap': 'Wrap',
					'codeBlock.unwrap': 'No wrap',
					footnotes: 'Footnotes',
					'status.loading': 'Loading…',
					'status.clean': 'Saved',
					'status.dirty': 'Unsaved',
					'status.saving': 'Saving…',
					'status.saved': 'Saved',
					'status.stale': 'Changed on disk',
					'status.failed': 'Save failed',
					'error.address': 'This preview does not name an editable session file.',
					'error.tooLarge': 'The file exceeds the editor size limit.',
					'error.noPreview': 'This shell provides no Markdown renderer.',
					'hint.noHighlight': 'plain',
					'hint.noHighlightWhy':
						'Not highlighted: the file is over the highlight cap, or this language is not in the platform table.',
					'hint.noMarks': 'no marks',
					'hint.noMarksWhy': 'Not marked: the file is over the mark cap.',
					'marks.eolLf': 'Line ending LF (U+000A)',
					'marks.eolCrlf': 'Line ending CRLF (U+000D U+000A)',
					'marks.noEol': 'No line ending at end of file',
					shortcut: 'Ctrl+S to save'
				}
			};
		}

		/** Prefix of every session file resource address. */
		const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

		/**
		* Read a session file address back into its session and path.
		*
		* @param address - a `dsh-resource://file/session/…` address.
		* @returns the parts, or undefined when the address is not session-scoped.
		*/
		function parseFileAddress(address) {
			if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
			const end = address.search(/[?#]/);
			const rest = address
				.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
				.split('/');
			if (rest[0] !== 'session') return undefined;
			const id = rest[1];
			const segments = rest.slice(2);
			if (id === undefined || id === '' || segments.length === 0) return undefined;
			try {
				return {
					sessionId: decodeURIComponent(id),
					path: segments.map((segment) => decodeURIComponent(segment)).join('/')
				};
			} catch {
				return undefined;
			}
		}

		/**
		* Ask the Host bridge for one read or save.
		*
		* @param payload - `{ op, sessionId, path, … }`.
		* @param signal - aborts with the tab.
		* @returns the parsed reply; transport faults come back as a failure reply.
		*/
		async function call(payload, signal) {
			let reply;
			try {
				reply = await fetch(ROUTE_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
					signal,
					credentials: 'same-origin'
				});
			} catch (error) {
				return {
					ok: false,
					code: 'E_TRANSPORT',
					message: `the editing bridge is unreachable: ${String(error?.message ?? error)}`
				};
			}
			let body;
			try {
				body = await reply.json();
			} catch {
				body = undefined;
			}
			if (body === undefined || body === null || typeof body !== 'object') {
				return {
					ok: false,
					code: `E_HTTP_${reply.status}`,
					message: `the editing bridge answered ${reply.status}`
				};
			}
			return body;
		}

		/**
		* UTF-8 size of the text a save would write.
		*
		* @param text - the buffer's text.
		* @returns its byte length.
		*/
		function byteLength(text) {
			try {
				return new TextEncoder().encode(text).length;
			} catch {
				return text.length * 2;
			}
		}

		/**
		* The suffix of the file this address names.
		*
		* @param path - the decoded path.
		* @returns its lowercased suffix without the dot.
		*/
		function suffixOf(path) {
			const file = path.slice(path.replaceAll('\\', '/').lastIndexOf('/') + 1);
			const dot = file.lastIndexOf('.');
			return dot <= 0 ? '' : file.slice(dot + 1).toLowerCase();
		}

		/**
		* Whether a path is absolute in either spelling the Host accepts.
		*
		* @param path - a filesystem path.
		* @returns true for POSIX, drive-letter, and UNC spellings.
		*/
		function isAbsoluteWorkspacePath(path) {
			return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
		}

		/**
		* Split a path into its directory prefix and its final segment.
		*
		* @param path - a filesystem path.
		* @returns both parts; a separator-only path is all name.
		*/
		function pathPartsOf(path) {
			const trimmed = path.replace(/[/\\]+$/, '');
			if (trimmed === '') return { directory: '', name: path };
			const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
			return { directory: trimmed.slice(0, cut), name: trimmed.slice(cut) };
		}

		/** A leading YAML frontmatter block; an unterminated block is not one. */
		const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u;

		/**
		* Separate a leading frontmatter block from the Markdown body without parsing
		* its YAML, using the delimiter rule the shipped preview uses.
		*
		* @param text - Markdown source.
		* @returns the frontmatter source and the remaining body, or `undefined`.
		*/
		function splitFrontmatter(text) {
			const match = FRONTMATTER.exec(text);
			return match === null ? undefined : { source: match[1] ?? '', body: text.slice(match[0].length) };
		}

		/**
		* Resolve one Markdown image destination to the app's authenticated file route,
		* the same way the shipped preview does it: relative destinations hang off the
		* document's own directory, and the result is served by `api/file?path=`.
		* Destinations carrying their own scheme, or an unusable path, stay unresolved
		* the way `MarkdownText` leaves them.
		*
		* @param base - `document.baseURI`, the origin the route hangs off.
		* @param documentPath - the absolute path of the document being previewed.
		* @param destination - the destination as written in the Markdown.
		* @returns an absolute URL, or `undefined` to leave the destination alone.
		*/
		function markdownImageUrl(base, documentPath, destination) {
			if (!/^https?:/u.test(base) && !String(base).startsWith('dsh-app://app/')) return undefined;
			const cut = String(destination).search(/[?#]/u);
			let path;
			try {
				path = decodeURIComponent(cut === -1 ? String(destination) : String(destination).slice(0, cut));
			} catch {
				return undefined;
			}
			if (path.length === 0) return undefined;
			if (!/^[a-z]:[/\\]/iu.test(path) && /^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
			if (!isAbsoluteWorkspacePath(path)) {
				if (documentPath === undefined) return undefined;
				path = pathPartsOf(documentPath).directory + path;
			}
			if (
				!isAbsoluteWorkspacePath(path) ||
				/^[/\\]{2}/u.test(path) ||
				/[\u0000-\u001f\u007f]/u.test(path)
			) {
				return undefined;
			}
			return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;
		}

		/** Shared presentation for the toolbar and the editor surface. */
		const styles = {
			root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
			bar: {
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				flex: 'none',
				padding: '0 8px',
				minHeight: '32px',
				borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24))',
				fontSize: '12px',
				color: 'var(--dsw-alias-label-secondary, inherit)'
			},
			path: {
				flex: '1 1 auto',
				minWidth: 0,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
			},
			status: { flex: 'none', whiteSpace: 'nowrap' },
			button: {
				flex: 'none',
				font: 'inherit',
				padding: '2px 8px',
				border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24))',
				borderRadius: 'var(--dsw-radius-sm, 4px)',
				background: 'transparent',
				color: 'inherit',
				cursor: 'pointer'
			},
			notice: {
				flex: 'none',
				padding: '6px 8px',
				fontSize: '12px',
				borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24))'
			},
			editor: {
				flex: '1 1 auto',
				minHeight: 0,
				width: '100%',
				// Positioned and lifted above the layer: the caret, the selection and
				// the pointer all belong to the textarea, never to the paint below it.
				position: 'relative',
				zIndex: 1,
				resize: 'none',
				border: '0',
				outline: 'none',
				boxSizing: 'border-box',
				padding: `${EDITOR_PAD_TOP}px ${EDITOR_PAD_LEFT}px`,
				background: 'transparent',
				color: 'var(--dsw-alias-label-primary, inherit)',
				fontFamily: EDITOR_MONOSPACE,
				fontSize: `${EDITOR_FONT_SIZE}px`,
				lineHeight: String(EDITOR_LINE_HEIGHT),
				tabSize: '2',
				overflowWrap: 'break-word',
				overflow: 'auto'
			},
			/**
			* The row holding the gutter and the box with the layer and the textarea.
			*
			* The gutter is a sibling of that box, never a child of the textarea: it
			* therefore cannot grow the scrollable area, cannot be copied with the text,
			* and cannot shift the glyphs the caret sits on.
			*/
			surface: {
				position: 'relative',
				flex: '1 1 auto',
				minHeight: 0,
				display: 'flex',
				overflow: 'hidden'
			},
			highlight: {
				position: 'absolute',
				inset: 0,
				zIndex: 0,
				margin: 0,
				border: '0',
				boxSizing: 'border-box',
				padding: `${EDITOR_PAD_TOP}px ${EDITOR_PAD_LEFT}px`,
				overflow: 'hidden',
				// The `.shiki` class may bring its own code-block background; the editor
				// keeps the panel's, since the caret layer sits on top of this one.
				background: 'transparent',
				pointerEvents: 'none',
				userSelect: 'none',
				color: 'var(--shiki-foreground, var(--dsw-alias-label-primary, inherit))',
				fontFamily: EDITOR_MONOSPACE,
				fontSize: `${EDITOR_FONT_SIZE}px`,
				lineHeight: String(EDITOR_LINE_HEIGHT),
				tabSize: '2',
				overflowWrap: 'break-word'
			},
			/**
			* The box holding the paint layer and the textarea.
			*
			* It takes the place `surface` had before the gutter existed: the layer
			* positions itself against this box with `inset: 0`, so both children still
			* carry the same padding, font, line height, tab size and wrapping — the
			* whole reason the caret lands on the glyphs below it.
			*/
			box: { position: 'relative', flex: '1 1 auto', minWidth: 0, display: 'flex' },
			/**
			* The line-number column.
			*
			* Its rows are positioned in the textarea's own content coordinates and the
			* whole strip is then translated by the textarea's scroll offset, so a row
			* stays level with the line it numbers without the gutter ever scrolling.
			*/
			gutter: {
				flex: 'none',
				position: 'relative',
				overflow: 'hidden',
				pointerEvents: 'none',
				userSelect: 'none',
				borderRight: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24))',
				background: 'var(--dsw-alias-bg-l2, rgba(128,128,128,.06))',
				fontFamily: EDITOR_MONOSPACE,
				fontSize: `${EDITOR_FONT_SIZE}px`,
				lineHeight: `${LINE_HEIGHT_PX}px`
			},
			/** The strip the row boxes are drawn in; `onScroll` translates it. */
			gutterInner: { position: 'absolute', inset: 0 },
			/** One number, absolutely placed at its line's top in content pixels. */
			gutterRow: {
				position: 'absolute',
				right: '6px',
				height: `${LINE_HEIGHT_PX}px`,
				color: 'var(--dsw-alias-label-secondary, inherit)',
				opacity: 0.55
			},
			/** The end-of-line mark drawn after a line's own glyphs. */
			eol: {
				color: 'rgba(214,145,0,.8)',
				pointerEvents: 'none',
				userSelect: 'none'
			},
			/** The end-of-line mark on a file that does not end with one. */
			eolMissing: {
				color: 'rgba(220,70,70,.9)',
				pointerEvents: 'none',
				userSelect: 'none'
			},
			/**
			* The band over one invisible character.
			*
			* Painted inside the character's own box and never substituted for it, so the
			* character keeps its width and the caret keeps its place.
			*/
			mark: {
				borderRadius: '2px',
				background: 'rgba(214,145,0,.2)',
				boxShadow: 'inset 0 -1px 0 0 rgba(214,145,0,.85)'
			},
			/** A zero-width character has no box to fill, so it gets an outline. */
			markZeroWidth: {
				borderRadius: '1px',
				outline: '1px solid rgba(214,145,0,.9)',
				outlineOffset: '1px'
			},
			/** The rendered Markdown surface, shown by this body's own preview toggle. */
			markdown: {
				flex: '1 1 auto',
				minHeight: 0,
				overflow: 'auto',
				padding: '12px 14px',
				fontSize: '13px',
				color: 'var(--dsw-alias-label-primary, inherit)'
			},
			/** A framed frontmatter block, shown verbatim above the body. */
			frontmatter: {
				marginBottom: '12px',
				border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24))',
				borderRadius: '6px',
				background: 'var(--dsw-alias-bg-l2, rgba(128,128,128,.06))',
				overflow: 'hidden'
			},
			frontmatterSource: {
				margin: 0,
				padding: '8px 10px',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
				fontSize: '12px',
				lineHeight: '1.5',
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
				color: 'var(--dsw-alias-label-secondary, inherit)'
			},
			empty: {
				flex: '1 1 auto',
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				gap: '10px',
				padding: '16px',
				textAlign: 'center',
				fontSize: '13px',
				color: 'var(--dsw-alias-label-secondary, inherit)'
			}
		};

		/**
		* The characters that are invisible on screen but present in the buffer.
		*
		* A plain space is deliberately absent: marking every space would drown the
		* characters that actually cause trouble. A space that trails its line is
		* marked separately, as a run, because that is where it usually matters.
		*/
		const INVISIBLE_CHARS = new Map([
			['\t', { name: 'tab' }],
			['\u00a0', { name: 'nbsp' }],
			['\u00ad', { name: 'soft hyphen' }],
			['\u200b', { name: 'zero width space', zeroWidth: true }],
			['\u200c', { name: 'zero width non-joiner', zeroWidth: true }],
			['\u200d', { name: 'zero width joiner', zeroWidth: true }],
			['\u200e', { name: 'left-to-right mark', zeroWidth: true }],
			['\u200f', { name: 'right-to-left mark', zeroWidth: true }],
			['\u2028', { name: 'line separator' }],
			['\u2029', { name: 'paragraph separator' }],
			['\u202f', { name: 'narrow no-break space' }],
			['\u205f', { name: 'medium mathematical space' }],
			['\u2060', { name: 'word joiner', zeroWidth: true }],
			['\u3000', { name: 'ideographic space' }],
			['\ufeff', { name: 'byte order mark', zeroWidth: true }]
		]);

		/**
		* Every C0 and C1 control character, except the tab, which has its own entry
		* above, and the newline, which is the line break rather than a character on
		* the line.
		*/
		const CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

		/** The run of spaces, or tabs, that trails a line. */
		const TRAILING_WHITESPACE = /[ \t]+$/u;

		/**
		* A character's code point in the `u+XXXX` form a mark's tooltip shows.
		*
		* @param char - one character of the buffer.
		* @returns e.g. `00A0`.
		*/
		function codePointOf(char) {
			return char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
		}

		/**
		* Describe one invisible character, for its mark's tooltip.
		*
		* The tooltip is deliberately language-neutral: the character has no local
		* name, and a name stays readable in every locale.
		*
		* @param char - one character of the buffer.
		* @param trailing - whether this position trails its line.
		* @returns the description, or undefined for ordinary text.
		*/
		function markOf(char, trailing) {
			const known = INVISIBLE_CHARS.get(char);
			if (known !== undefined) return { ...known, codePoint: codePointOf(char) };
			// Only a space has to be looked at positionally: a trailing one is as
			// invisible as any character in the table, an interior one is just a space.
			if (trailing === true && char === ' ') return { name: 'trailing space', codePoint: codePointOf(char) };
			if (CONTROL_CHAR.test(char)) return { name: 'control', codePoint: codePointOf(char) };
			return undefined;
		}

		/**
		* Split one piece of a line at the characters that cannot be seen.
		*
		* The characters themselves pass through unchanged — only their markup does —
		* so every glyph keeps the advance width it has in the textarea and a caret in
		* the textarea still lands on the glyph painted below it.
		*
		* @param text - one token's text, or a whole plain line.
		* @param offset - this text's character offset within its line.
		* @param trailingFrom - the line offset its trailing whitespace run starts at.
		* @returns runs of `{ text, mark }`; `mark` is absent for ordinary text.
		*/
		function splitInvisible(text, offset, trailingFrom) {
			const runs = [];
			let plain = '';
			let index = offset;
			for (const char of text) {
				const mark = markOf(char, index >= trailingFrom);
				if (mark === undefined) {
					plain += char;
				} else {
					if (plain !== '') runs.push({ text: plain });
					plain = '';
					runs.push({ text: char, mark });
				}
				index += char.length;
			}
			if (plain !== '') runs.push({ text: plain });
			return runs;
		}

		/**
		* The style that marks one invisible character in place.
		*
		* @param mark - the description from `markOf`.
		* @returns the properties merged onto the character's own span.
		*/
		function markStyle(mark) {
			return mark.zeroWidth === true ? styles.markZeroWidth : styles.mark;
		}

		/**
		* The end-of-line mark one particular line should carry.
		*
		* @param ends - the mark descriptions, or undefined when marks are off.
		* @param last - whether this is the buffer's last line.
		* @returns the mark, or undefined when this line carries none.
		*/
		function endMarkOf(ends, last) {
			if (ends === undefined) return undefined;
			return last === true && ends.trailing !== true ? ends.noEol : ends.eol;
		}

		/**
		* One line of a paint layer, with its invisible characters marked in place.
		*
		* Everything this adds to the line — the marks and the end-of-line mark — is
		* added inside a character's own box or after the line's last glyph, so not one
		* glyph moves.
		*
		* @param tokens - the line's pieces with the styles to keep on them; the plain
		*   layer passes one piece for the whole line.
		* @param key - the line's index.
		* @param marks - whether the invisible characters are marked.
		* @param ends - the end-of-line marks, or undefined when they are off.
		* @param last - whether this is the buffer's last line.
		* @returns the line's box, carrying the `data-preview-editor-line` hook the
		*   gutter measures its rows against.
		*/
		function paintLine(tokens, key, marks, ends, last) {
			const whole = tokens.map((token) => token.text).join('');
			const trailing = marks === true ? (TRAILING_WHITESPACE.exec(whole)?.[0].length ?? 0) : 0;
			const trailingFrom = whole.length - trailing;
			const children = [];
			let offset = 0;
			for (const token of tokens) {
				const runs =
					marks === true ? splitInvisible(token.text, offset, trailingFrom) : [{ text: token.text }];
				for (const run of runs) {
					children.push(
						h(
							'span',
							{
								key: children.length,
								style: run.mark === undefined ? token.style : { ...token.style, ...markStyle(run.mark) },
								title: run.mark === undefined ? undefined : `u+${run.mark.codePoint} ${run.mark.name}`
							},
							run.text
						)
					);
				}
				offset += token.text.length;
			}
			// An empty line still needs a box for the gutter to measure, and a
			// zero-width character gives it one without changing any width.
			if (children.length === 0) children.push(h('span', { key: 0 }, '\u200b'));
			const end = endMarkOf(ends, last);
			if (end !== undefined) {
				children.push(
					h(
						'span',
						{
							key: 'end',
							style: end.missing === true ? styles.eolMissing : styles.eol,
							title: end.title
						},
						end.glyph
					)
				);
			}
			return h('span', { key, className: 'line', 'data-preview-editor-line': true }, children);
		}

		/**
		* The boxes of one layer, joined by the newlines that separate their rows.
		*
		* @param rows - the lines' tokens, one entry per row.
		* @param marks - whether the invisible characters are marked.
		* @param ends - the end-of-line marks, or undefined when they are off.
		* @returns the layer's children, separators included.
		*/
		function paintRows(rows, marks, ends) {
			const lastIndex = rows.length - 1;
			const children = [];
			rows.forEach((tokens, index) => {
				if (index > 0) children.push('\n');
				children.push(paintLine(tokens, index, marks, ends, index === lastIndex));
			});
			return children;
		}

		/**
		* The token rows of a highlighted buffer, padded to the rows it must draw.
		*
		* @param tokens - the tokenizer's lines.
		* @param text - the buffer.
		* @returns one token list per row.
		*/
		function tokenRows(tokens, text) {
			const rows = tokens.map((line) => line.map((token) => ({ text: token.text, style: token.style })));
			// The tokenizer drops a trailing empty line; it is a row all the same.
			if (text.endsWith('\n') || rows.length === 0) rows.push([]);
			return rows;
		}

		/**
		* The rows a paint layer must draw, and the gutter must number, for a buffer.
		*
		* A buffer that ends with a newline still shows an empty row after it, so the
		* count comes from the text itself rather than from the tokenizer, which drops
		* that last empty line.
		*
		* @param text - the buffer.
		* @returns the number of rows.
		*/
		function rowCount(text) {
			// The body renders once with `{ status: 'loading' }` before the read lands,
			// so `text` is undefined on that first render. Every computed value above
			// the return tree must tolerate that: an exception here aborts the whole
			// render, which also stops React from committing the effect that starts the
			// read — the pane then stays blank forever.
			return typeof text === 'string' ? text.split('\n').length : 1;
		}

		/**
		* A pixel value with the sub-pixel noise of a floating-point line height gone.
		*
		* @param value - a length in CSS pixels.
		* @returns the value, rounded to a hundredth.
		*/
		function pixels(value) {
			return Math.round(value * 100) / 100;
		}

		/**
		* Whether two measured row-top lists agree.
		*
		* Measuring runs after every edit, and re-rendering for an unchanged list
		* would make typing pay for the gutter twice.
		*
		* @param left - the previous tops.
		* @param right - the freshly measured tops.
		* @returns whether they agree.
		*/
		function sameTops(left, right) {
			if (left.length !== right.length) return false;
			for (let index = 0; index < left.length; index += 1) {
				if (Math.abs((left[index] ?? 0) - (right[index] ?? 0)) > 0.01) return false;
			}
			return true;
		}

		/**
		* The coloured layer that sits under the transparent textarea.
		*
		* It draws nothing of its own: same box, same padding, same font metrics as
		* the textarea above it, and exactly the bytes it is given, so a caret in the
		* textarea lands on the glyph the layer painted. Mounted only while the buffer
		* is painted at all, which also keeps the platform highlighter from being
		* constructed for a buffer whose marks are off.
		*
		* @param props - the text, the language hint, the wrap mode, the mark switch,
		*   the end-of-line marks, and the layer ref the textarea drives so both scroll
		*   together.
		* @returns the layer, or nothing when the highlighter has no tokens.
		*/
		function HighlightLayer({ text, language, wrap, marks, ends, layerRef }) {
			const highlight = primitives.useCodeHighlighter(language);
			// Typing must not wait for tokenizing: the layer trails the textarea.
			const deferred = React.useDeferredValue(text);
			const tokens = React.useMemo(() => {
				try {
					return highlight(deferred);
				} catch {
					return undefined;
				}
			}, [highlight, deferred]);
			if (tokens === undefined) return null;
			return h(
				'pre',
				{
					ref: layerRef,
					className: 'shiki css-variables',
					'aria-hidden': 'true',
					'data-preview-editor-highlight': true,
					style: { ...styles.highlight, whiteSpace: wrap === true ? 'pre-wrap' : 'pre' }
				},
				paintRows(tokenRows(tokens, deferred), marks, ends)
			);
		}

		/**
		* The paint layer for a buffer with no highlighting.
		*
		* Same box and metrics as `HighlightLayer`. It exists because the platform
		* highlighter is a hook: a component that may not call it cannot be the same
		* component as one that must, so the plain case gets its own.
		*
		* @param props - the text, the wrap mode, the mark switch, the end-of-line
		*   marks, and the layer ref the textarea drives.
		* @returns the layer.
		*/
		function PlainLayer({ text, wrap, marks, ends, layerRef }) {
			// As above: the layer trails the textarea while typing.
			const deferred = React.useDeferredValue(text);
			const rows = React.useMemo(
				() => deferred.split('\n').map((line) => [{ text: line }]),
				[deferred]
			);
			return h(
				'pre',
				{
					ref: layerRef,
					'aria-hidden': 'true',
					'data-preview-editor-layer': 'plain',
					style: { ...styles.highlight, whiteSpace: wrap === true ? 'pre-wrap' : 'pre' }
				},
				paintRows(rows, marks, ends)
			);
		}

		/**
		* The line-number column beside the editor.
		*
		* The rows are absolutely placed at the lines' own content offsets and the
		* strip is then translated by the textarea's scroll offset, so a number stays
		* level with its line without the gutter itself ever scrolling.
		*
		* @param props - the row count, the measured line tops, and the strip ref the
		*   textarea's scrolling translates.
		* @returns the column.
		*/
		function LineNumbers({ count, tops, innerRef }) {
			const rows = [];
			for (let index = 0; index < count; index += 1) {
				const top = typeof tops[index] === 'number' ? tops[index] : EDITOR_PAD_TOP + index * LINE_HEIGHT_PX;
				rows.push(
					h('div', { key: index, style: { ...styles.gutterRow, top: `${pixels(top)}px` } }, index + 1)
				);
			}
			return h(
				'div',
				{
					style: { ...styles.gutter, width: `${String(count).length + 2}ch` },
					'aria-hidden': 'true',
					'data-preview-editor-gutter': true
				},
				h('div', { ref: innerRef, style: styles.gutterInner }, rows)
			);
		}

		/**
		* The editor body registered under `sidebar.right.tab.document`.
		*
		* @param props - composed slot props: the renderer request, tab hooks, the
		* resource address, and the namespaced translator.
		* @returns the editor, a loading line, or the failure state.
		*/
		function EditorBody(props) {
			const t = typeof props.t === 'function' ? props.t : (key) => key;
			const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
			const tab = info?.tab ?? {};
			const request = props.content?.kind === 'renderer' ? props.content : undefined;
			const revision = request?.revision;
			const address = props.resourceAddress ?? tab.contentId;
			const file = React.useMemo(() => parseFileAddress(address), [address]);
			/** `{ status, text, version, eol, baseline, notice, saving, message }`. */
			const [draft, setDraft] = React.useState({ status: 'loading' });
			/** Whether a Markdown file is being shown rendered instead of edited. */
			const [preview, setPreview] = React.useState(editingMarkdownFirst);
			/** The layer under the textarea; the textarea's scrolling drives it. */
			const layerRef = React.useRef(null);
			/** The gutter's strip, translated by the same scroll offset. */
			const gutterRef = React.useRef(null);
			/** The row area, watched so a resize re-measures the gutter's rows. */
			const surfaceRef = React.useRef(null);
			/** The textarea itself, read for the offset the gutter follows. */
			const editorRef = React.useRef(null);
			/** Each painted line's top, in content pixels; empty while unmeasured. */
			const [tops, setTops] = React.useState([]);
			const live = React.useRef(true);
			// Images inside the rendered view would need the preview owner's resource
			// plumbing, which this body does not receive; see the README limits.
			const markdownLabels = React.useMemo(
				() => ({
					code: {
						copyLabel: t('code.copy'),
						copiedLabel: t('code.copied'),
						toolbarLabels: {
							codeLabel: t('codeBlock.title'),
							wrapLabel: t('codeBlock.wrap'),
							unwrapLabel: t('codeBlock.unwrap')
						}
					},
					footnotes: t('footnotes')
				}),
				[t]
			);
			const isMarkdown =
				file !== undefined && MARKDOWN_EXTENSIONS.includes(suffixOf(file.path));
			// The leading frontmatter block gets framed instead of leaking into the
			// body, and relative images resolve against the document's own directory —
			// both restored from the shipped preview's own rules, from this body.
			const frontmatter = draft.status === 'ready' ? splitFrontmatter(draft.text) : undefined;
			const pathImages = React.useMemo(
				() =>
					draft.status === 'ready' && draft.path !== undefined && typeof document !== 'undefined'
						? { resolve: (value) => markdownImageUrl(document.baseURI, draft.path, value) }
						: undefined,
				[draft.status, draft.path]
			);
			// The platform names one language per path; an unknown path yields none,
			// which simply leaves the editor plain.
			const language =
				file === undefined || primitives === undefined || typeof primitives.languageForPath !== 'function'
					? undefined
					: primitives.languageForPath(file.path);

			/**
			* The end-of-line marks the paint layer draws after every line's glyphs.
			*
			* `↵` for LF and `⏎` for CRLF: which of the two the file uses is invisible
			* otherwise, and a file that ends without any line ending says so instead.
			* The glyphs and the tooltips are language-neutral, like the marks.
			*/
			const ends = React.useMemo(
				() => ({
					eol:
						draft.eol === '\r\n'
							? { glyph: '\u23ce', title: t('marks.eolCrlf') }
							: { glyph: '\u21b5', title: t('marks.eolLf') },
					noEol: { glyph: '\u2205', title: t('marks.noEol'), missing: true },
					trailing: draft.status !== 'ready' || draft.text.endsWith('\n')
				}),
				[draft.status, draft.text, draft.eol, t]
			);

			React.useEffect(() => {
				live.current = true;
				return () => {
					live.current = false;
				};
			}, []);

			const load = React.useCallback(
				(signal) => {
					if (file === undefined) {
						setDraft({ status: 'error', message: t('error.address') });
						return;
					}
					setDraft({ status: 'loading' });
					call({ op: 'read', sessionId: file.sessionId, path: file.path }, signal)
						.then((reply) => {
							if (!live.current || signal?.aborted === true) return;
							if (reply.ok !== true) {
								request?.failed?.();
								setDraft({ status: 'error', message: `${reply.message ?? reply.code}` });
								return;
							}
							const eol = typeof reply.text === 'string' && reply.text.includes('\r\n') ? '\r\n' : '\n';
							const text =
								typeof reply.text === 'string' && eol === '\r\n'
									? reply.text.replace(/\r\n/g, '\n')
									: reply.text;
							setDraft({
								status: 'ready',
								text: text ?? '',
								baseline: text ?? '',
								version: reply.version,
								eol,
								path: reply.absolutePath,
								notice: undefined,
								saving: false
							});
							request?.loaded?.(reply.version);
						})
						.catch((error) => {
							if (!live.current || signal?.aborted === true) return;
							request?.failed?.();
							setDraft({ status: 'error', message: String(error?.message ?? error) });
						});
				},
				[file?.sessionId, file?.path, revision]
			);

			React.useEffect(() => {
				const controller = new AbortController();
				load(controller.signal);
				return () => controller.abort();
			}, [load, revision]);

			const save = React.useCallback(() => {
				if (file === undefined) return;
				const current = draft;
				if (current.status !== 'ready' || current.saving === true) return;
				const text =
					current.eol === '\r\n' ? current.text.replace(/\n/g, '\r\n') : current.text;
				setDraft({ ...current, saving: true, notice: undefined });
				call({
					op: 'save',
					sessionId: file.sessionId,
					path: file.path,
					text,
					version: current.version
				})
					.then((reply) => {
						if (!live.current) return;
						if (reply.ok === true) {
							setDraft({
								...current,
								saving: false,
								version: reply.version,
								baseline: current.text,
								notice: { kind: 'ok', text: t('status.saved') }
							});
							request?.loaded?.(reply.version);
							return;
						}
						setDraft({
							...current,
							saving: false,
							notice: {
								kind: reply.code === 'FS_STALE_VERSION' ? 'stale' : 'error',
								text:
									reply.code === 'FS_STALE_VERSION'
										? t('status.stale')
										: `${t('status.failed')}: ${reply.message ?? reply.code}`
							}
						});
					})
					.catch((error) => {
						if (!live.current) return;
						setDraft({
							...current,
							saving: false,
							notice: { kind: 'error', text: `${t('status.failed')}: ${String(error?.message ?? error)}` }
						});
					});
			}, [draft, file?.sessionId, file?.path, request]);

			// The rendered view replaces the textarea, so the shortcut the textarea
			// would have handled has to be caught one level up while it is shown.
			React.useEffect(() => {
				if (preview !== true) return undefined;
				const onKeyDown = (event) => {
					if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
						event.preventDefault();
						save();
					}
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [preview, save]);

			/**
			* Whether the marks are drawn at all, and why they are not.
			*
			* Computed before the early return below because the gutter's measurement is
			* a hook, and a hook may not sit behind a branch.
			*/
			const marksSkipped =
				editingMarks.enabled === true &&
				draft.status === 'ready' &&
				byteLength(draft.text) > editingMarks.maxBytes
					? 'large'
					: undefined;
			const marksOn = editingMarks.enabled === true && draft.status === 'ready' && marksSkipped === undefined;

			// The gutter follows the textarea: the rows sit at the painted lines' own
			// content offsets and the strip is then translated by the scroll offset.
			React.useEffect(() => {
				if (editingLineNumbers !== true || draft.status !== 'ready') {
					setTops((current) => (current.length === 0 ? current : []));
					return undefined;
				}
				const sync = () => {
					const editor = editorRef.current;
					const strip = gutterRef.current;
					if (editor !== null && strip !== null) {
						strip.style.transform = `translateY(${-editor.scrollTop}px)`;
					}
					const layer = layerRef.current;
					if (layer === null) {
						setTops((current) => (current.length === 0 ? current : []));
						return;
					}
					const measured = [];
					let top;
					try {
						const base = layer.getBoundingClientRect();
						for (const box of layer.querySelectorAll('[data-preview-editor-line]')) {
							const rects = box.getClientRects();
							// A row the browser reports no box for — an empty line, say —
							// continues one line box below the row above it.
							if (rects.length === 0) {
								top = top === undefined ? undefined : top + LINE_HEIGHT_PX;
							} else {
								top = rects[0].top - base.top + layer.scrollTop;
							}
							measured.push(top);
						}
					} catch {
						measured.length = 0;
					}
					setTops((current) => (sameTops(current, measured) ? current : measured));
				};
				sync();
				// Fonts and layout settle a frame later, so measure once more.
				const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sync) : undefined;
				let observer;
				if (typeof ResizeObserver === 'function' && surfaceRef.current !== null) {
					observer = new ResizeObserver(sync);
					observer.observe(surfaceRef.current);
				}
				return () => {
					if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
					observer?.disconnect();
				};
			}, [draft.status, draft.text, props.wrap, marksOn]);

			if (draft.status === 'error') {
				return h(
					'div',
					{ style: styles.empty, 'data-preview-editor': 'failed' },
					h('p', { style: { margin: 0 } }, draft.message ?? t('status.failed')),
					h(
						'button',
						{ type: 'button', style: styles.button, onClick: () => load(undefined) },
						t('action.retry')
					)
				);
			}

			// The read is asynchronous: return a visible state on the first render so
			// the pane is never an empty rectangle, and so `draft.text` (still undefined
			// here) is never handed to the gutter, the marks or the textarea.
			if (draft.status !== 'ready') {
				return h('div', { style: styles.empty, 'data-preview-editor': 'loading' }, t('status.loading'));
			}

			const dirty = draft.status === 'ready' && draft.text !== draft.baseline;
			const tooLarge = draft.status === 'ready' && byteLength(draft.text) > editingMaxBytes;
			// The preview's own wrap state drives both layers, so they always agree.
			const wrapMode = props.wrap === true;
			const highlightSkipped =
				primitives === undefined || language === undefined
					? 'unavailable'
					: draft.status === 'ready' && byteLength(draft.text) > editingHighlight.maxBytes
						? 'large'
						: undefined;
			const highlighting = editingHighlight.enabled === true && highlightSkipped === undefined;
			// The glyphs live in the layer whenever it draws them at all: the marks
			// alone are reason enough to make the textarea's own text invisible.
			const painted = highlighting === true || marksOn === true;
			/** The rows the textarea shows, which the gutter numbers and the layers draw. */
			const rowTotal = rowCount(draft.text);
			// Markdown is editable by default, so the rendered view lives in this body
			// rather than only in a viewer menu the user may not reach.
			const previewing = preview === true && isMarkdown === true && draft.status === 'ready';
			const status =
				draft.status === 'loading'
					? t('status.loading')
					: draft.saving === true
						? t('status.saving')
						: tooLarge
							? t('error.tooLarge')
							: dirty
								? t('status.dirty')
								: t('status.clean');
			const shown = draft.path ?? file?.path ?? String(address ?? '');

			return h(
				'div',
				{ style: styles.root, 'data-preview-editor': 'ready' },
				h(
					'div',
					{ style: styles.bar },
					h('span', { style: styles.path, title: shown, key: 'path' }, shown),
					h('span', { style: styles.status, key: 'status' }, status),
					editingHighlight.enabled === true && highlightSkipped !== undefined
						? h(
								'span',
								{
									key: 'highlight',
									style: styles.status,
									title: t('hint.noHighlightWhy')
								},
								t('hint.noHighlight')
							)
						: null,
					editingMarks.enabled === true && marksSkipped !== undefined
						? h(
								'span',
								{ key: 'marks', style: styles.status, title: t('hint.noMarksWhy') },
								t('hint.noMarks')
							)
						: null,
					isMarkdown === true && draft.status === 'ready'
						? h(
								'button',
								{
									type: 'button',
									key: 'preview',
									style: styles.button,
									'data-preview-editor-toggle': previewing ? 'edit' : 'preview',
									onClick: () => setPreview((value) => value !== true)
								},
								previewing ? t('action.edit') : t('action.preview')
							)
						: null,
					h(
						'button',
						{
							type: 'button',
							key: 'reload',
							style: styles.button,
							onClick: () => load(undefined)
						},
						t('action.reload')
					),
					h(
						'button',
						{
							type: 'button',
							key: 'save',
							style: styles.button,
							disabled: draft.status !== 'ready' || dirty !== true || draft.saving === true || tooLarge,
							onClick: save
						},
						t('action.save')
					)
				),
				draft.notice === undefined
					? null
					: h(
							'div',
							{
								key: 'notice',
								style: {
									...styles.notice,
									color:
										draft.notice.kind === 'ok'
											? 'var(--dsw-alias-label-secondary, inherit)'
											: 'var(--dsw-alias-state-warn-label, inherit)'
								}
							},
							draft.notice.text
						),
				draft.status === 'loading'
					? h('div', { key: 'loading', style: styles.empty }, t('status.loading'))
					: previewing
						? h(
								'div',
								{ key: 'preview', style: styles.markdown, 'data-preview-editor-markdown': true },
								frontmatter === undefined
									? null
									: h(
											'div',
											{
												key: 'frontmatter',
												style: styles.frontmatter,
												'data-preview-editor-frontmatter': true
											},
											h('pre', { style: styles.frontmatterSource }, frontmatter.source)
										),
								primitives === undefined || typeof primitives.MarkdownText === 'undefined'
									? h('p', { key: 'nomarkdown', style: { margin: 0 } }, t('error.noPreview'))
									: h(primitives.MarkdownText, {
											key: 'markdown',
											text: frontmatter === undefined ? draft.text : frontmatter.body,
											labels: markdownLabels,
											pathImages
										})
							)
						: h(
							'div',
							{ key: 'surface', ref: surfaceRef, style: styles.surface },
							editingLineNumbers === true
								? h(LineNumbers, { key: 'gutter', count: rowTotal, tops, innerRef: gutterRef })
								: null,
							h(
								'div',
								{ key: 'box', style: styles.box },
								painted === true
									? highlighting === true
										? h(HighlightLayer, {
												key: 'highlight',
												layerRef,
												text: draft.text,
												language,
												wrap: wrapMode,
												marks: marksOn,
												ends
											})
										: h(PlainLayer, {
												key: 'plain',
												layerRef,
												text: draft.text,
												wrap: wrapMode,
												marks: marksOn,
												ends
											})
									: null,
								h('textarea', {
								key: 'editor',
								ref: editorRef,
								style: {
									...styles.editor,
									// The glyphs live in the layer; the textarea keeps only the
									// caret and the selection, so its own text stays invisible.
									color: painted
										? 'transparent'
										: 'var(--dsw-alias-label-primary, inherit)',
									caretColor: 'var(--dsw-alias-label-primary, inherit)',
									whiteSpace: wrapMode ? 'pre-wrap' : 'pre'
								},
								value: draft.text,
								wrap: wrapMode ? 'soft' : 'off',
								spellCheck: false,
								autoComplete: 'off',
								autoCorrect: 'off',
								autoCapitalize: 'off',
								'aria-label': shown,
								onScroll: (event) => {
									const layer = layerRef.current;
									const strip = gutterRef.current;
									if (layer !== null) {
										layer.scrollTop = event.target.scrollTop;
										layer.scrollLeft = event.target.scrollLeft;
									}
									if (strip !== null) {
										strip.style.transform = `translateY(${-event.target.scrollTop}px)`;
									}
								},
								onChange: (event) => setDraft({ ...draft, text: event.target.value, notice: undefined }),
							onKeyDown: (event) => {
								if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
									event.preventDefault();
									save();
									return;
								}
								if (event.key === 'Tab') {
									event.preventDefault();
									const target = event.target;
									const start = target.selectionStart;
									const end = target.selectionEnd;
									const next = `${draft.text.slice(0, start)}  ${draft.text.slice(end)}`;
									setDraft({ ...draft, text: next, notice: undefined });
									const caret = start + 2;
									requestAnimationFrame(() => {
										target.selectionStart = caret;
										target.selectionEnd = caret;
									});
								}
							}
						})
						)
					)
			);
		}

		/**
		* Register the renderer metadata and its keyed body.
		*
		* @param ctx - client root context carrying the preview registry and slots.
		* @param config - the row config, when the client half receives it.
		*/
		function apply(ctx, config) {
			const cfg = resolveConfig(globalThis.__DSH_PREVIEW_EDITOR_CONFIG__ ?? config);
			editingMaxBytes = cfg.maxBytes;
			editingHighlight = { enabled: cfg.highlight, maxBytes: cfg.highlightMaxBytes };
			editingMarks = { enabled: cfg.marks, maxBytes: cfg.marksMaxBytes };
			editingLineNumbers = cfg.lineNumbers;
			editingMarkdownFirst = cfg.markdown.first;
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(
				() => ctx.locale.register(LOCALE_NS, dictionaries()),
				'preview-editor: dictionaries'
			);
			// One renderer per priority band; both mount the same body under their own key.
			const registerRenderer = (id, extensions, priority, label) => {
				ctx.effect(
					() =>
						ctx.documentPreviews.register({
							id,
							extensions,
							priority,
							title: () => t('viewer.label'),
							loading: 'renderer',
							wrap: false
						}),
					`preview-editor: ${label}`
				);
				ctx.effect(
					() =>
						ctx.slots.inject('sidebar.right.tab.document', () =>
							ctx.slots.register(
								{ name: 'sidebar.right.tab.document', key: id, locale: LOCALE_NS },
								EditorBody
							)
						),
					`preview-editor: ${label} body`
				);
			};
			// Registering in the shipped `builtin` band (after the platform's own
			// Code / Text / Markdown viewers) keeps those as the default and makes
			// Edit the last of the *matched* viewers. It cannot be the last menu entry
			// overall: the owner appends its plain-text fallback unconditionally
			// (`candidates = [...matched, plainText]`), so "Plain text" is always the
			// final row. The `extension` band is kept only for `editableAsDefault`.
			const band = cfg.editableAsDefault === true ? 'extension' : 'builtin';
			registerRenderer(EDITOR_ID, cfg.extensions, band, 'renderer');
			registerRenderer(
				MARKDOWN_EDITOR_ID,
				cfg.markdown.extensions,
				cfg.markdown.priority,
				'markdown renderer'
			);
			// `resolveConfig` exposes `markdown.first` (rendered view shown first, from
			// `markdown: false`); the editor is the default exactly when it is false.
			// This line previously read a `byDefault` property that never existed and
			// logged `undefined`.
			ctx.logger?.info?.(
				`preview-editor: editing renderer registered for ${cfg.extensions.length} suffixes and ${cfg.markdown.extensions.length} markdown suffixes (editor default for markdown: ${!cfg.markdown.first})`
			);
		}

		/** Services this client half reads; `documentPreviews` owns the registry. */
		const inject = ['documentPreviews', 'slots', 'locale'];

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		exports.EditorBody = EditorBody;
		return module.exports;
	}
});