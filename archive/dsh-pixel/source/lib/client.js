/* global window, document, fetch */
/**
 * Client half of the 'dsh-pixel' plugin.
 *
 * A left-rail pixel workbench for authoring an IP mark: it lists the works in a
 * pixel store, edits their character grids, and exports the integer upscale
 * ladder the IP needs (48 native -> 96 / 144 / 192 / 240 / 288 / 384 / 480 /
 * 768 / 1008). All storage and PNG encoding stays in the store's Host route, so
 * nothing here touches the filesystem.
 *
 * Registration goes through the core slots registry: the app is a 'main' panel
 * opened from a left-rail key, and it also publishes a right Sidebar tab type,
 * a shortcut card and a title. Nothing here depends on a third-party Sidebar
 * wrapper, so the app survives in a profile that lacks one.
 */
window.__ModuleLoader__.load({
	id: 'dsh-pixel',
	factory(require) {
		var React = require('react');
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useCallback = React.useCallback;
var useMemo = React.useMemo;

		/** Same-origin Host route owned by @muxiuesd/dsh-pixel-studio. */
		var API = '/dsh-pixel-studio';

		/** Same-origin Host route owned by THIS package: the IP asset family. */
		var EXPORT_API = '/dsh-pixel';

		/** The integer ladder an IP mark exports at (native grid x these = the family). */
		var SCALES = [1, 2, 3, 4, 5, 6, 8, 10, 16, 21];

		/** Slot alphabet the Host store uses, one character per palette entry. */
		var BASE_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
		function extraChars() {
			var out = '';
			for (var i = 0; i < 220; i += 1) out += String.fromCharCode(0xe000 + i);
			return out;
		}
		var CHARS = BASE_CHARS + extraChars();

		function call(op, payload) {
			return post(API, op, payload, { 'x-pixel-studio': '1' });
		}

		/** The Host half of this package owns the asset family, not the store. */
		/**
 * Attaches this instance's file-name slug to a document before export.
 *
 * The Host half names files `<slug>-<side>.png` and never invents a prefix,
 * so the brand a deployment wants lives here, in one place.
 */
function withSlug(doc) {
	if (!doc) return doc;
	var copy = {};
	for (var key in doc) {
		if (Object.prototype.hasOwnProperty.call(doc, key)) copy[key] = doc[key];
	}
	copy.slug = BRAND.slug;
	return copy;
}

function exportCall(op, payload) {
			return post(EXPORT_API, op, payload, {});
		}

		function post(url, op, payload, headers) {
			var body = { op: op };
			if (payload) {
				for (var key in payload) {
					if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
				}
			}
			var merged = { 'content-type': 'application/json' };
			for (var name in headers) {
				if (Object.prototype.hasOwnProperty.call(headers, name)) merged[name] = headers[name];
			}
			return fetch(url, {
				method: 'POST',
				headers: merged,
				body: JSON.stringify(body),
			})
				.then(function (response) {
					return response.json().catch(function () {
						return { ok: false, error: 'bad-response' };
					});
				})
				.then(function (json) {
					if (!json || json.ok !== true) throw new Error((json && json.error) || 'request-failed');
					return json;
				});
		}

		function hexToRgb(hex) {
			return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
		}

		function clamp(value, low, high) {
			return Math.min(high, Math.max(low, value));
		}

		/* ------------------------------------------------------------------ */
		/* canvas                                                              */
		/* ------------------------------------------------------------------ */

		function paintCanvas(canvas, doc, zoom, options) {
			if (!canvas || !doc) return;
			var width = doc.w;
			var height = doc.h;
			var px = width * zoom;
			var py = height * zoom;
			if (canvas.width !== px) canvas.width = px;
			if (canvas.height !== py) canvas.height = py;
			canvas.style.width = px + 'px';
			canvas.style.height = py + 'px';

			var context = canvas.getContext('2d');
			if (!context) return;
			context.clearRect(0, 0, px, py);

			// Transparency checker, drawn in device pixels so it never scales with zoom.
			var step = 8;
			context.fillStyle = '#f2f4f7';
			context.fillRect(0, 0, px, py);
			context.fillStyle = '#e3e7ee';
			for (var cy = 0; cy < py; cy += step) {
				for (var cx = 0; cx < px; cx += step) {
					if (((cx / step) + (cy / step)) % 2 === 0) continue;
					context.fillRect(cx, cy, step, step);
				}
			}

			var palette = doc.palette || [];
			var layers = doc.layers || [];
			for (var index = 0; index < layers.length; index += 1) {
				var layer = layers[index];
				if (layer.visible === false) continue;
				var rows = layer.rows || [];
				for (var y = 0; y < height; y += 1) {
					var row = rows[y] || '';
					for (var x = 0; x < width; x += 1) {
						var ch = row.charAt(x);
						if (ch === '' || ch === '.') continue;
						var slot = CHARS.indexOf(ch);
						var hex = palette[slot];
						if (!hex) continue;
						context.fillStyle = hex;
						context.fillRect(x * zoom, y * zoom, zoom, zoom);
					}
				}
			}

			if (options && options.grid === true && zoom >= 8) {
				context.strokeStyle = 'rgba(12, 24, 40, 0.18)';
				context.lineWidth = 1;
				context.beginPath();
				for (var gx = 1; gx < width; gx += 1) {
					context.moveTo(gx * zoom + 0.5, 0);
					context.lineTo(gx * zoom + 0.5, py);
				}
				for (var gy = 1; gy < height; gy += 1) {
					context.moveTo(0, gy * zoom + 0.5);
					context.lineTo(px, gy * zoom + 0.5);
				}
				context.stroke();
			}

			if (options && options.symmetry === true) {
				context.strokeStyle = 'rgba(255, 138, 164, 0.75)';
				context.lineWidth = 1;
				context.beginPath();
				context.moveTo(px / 2 + 0.5, 0);
				context.lineTo(px / 2 + 0.5, py);
				context.stroke();
			}
		}

		/* ------------------------------------------------------------------ */
		/* styles                                                              */
		/* ------------------------------------------------------------------ */

		var S = {
			root: {
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				minHeight: 0,
				font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
				color: 'var(--dsh-text-primary, #1d2433)',
				background: 'var(--dsh-bg-primary, #fff)',
			},
			bar: {
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				padding: '6px 8px',
				borderBottom: '1px solid var(--dsh-border-subtle, #e6e9ef)',
				flex: '0 0 auto',
				flexWrap: 'wrap',
			},
			body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
			rail: {
				width: 132,
				flex: '0 0 132px',
				borderRight: '1px solid var(--dsh-border-subtle, #e6e9ef)',
				overflowY: 'auto',
				padding: 6,
				boxSizing: 'border-box',
			},
			stage: {
				flex: '1 1 auto',
				minWidth: 0,
				overflow: 'auto',
				display: 'flex',
				alignItems: 'flex-start',
				justifyContent: 'center',
				padding: 12,
				boxSizing: 'border-box',
			},
			side: {
				width: 104,
				flex: '0 0 104px',
				borderLeft: '1px solid var(--dsh-border-subtle, #e6e9ef)',
				overflowY: 'auto',
				padding: 6,
				boxSizing: 'border-box',
			},
			item: {
				display: 'block',
				width: '100%',
				textAlign: 'left',
				padding: '5px 6px',
				marginBottom: 3,
				borderRadius: 5,
				border: '1px solid transparent',
				background: 'transparent',
				color: 'inherit',
				cursor: 'pointer',
				font: 'inherit',
			},
			itemActive: { background: 'rgba(42, 108, 156, 0.14)', borderColor: 'rgba(42, 108, 156, 0.5)' },
			button: {
				padding: '3px 8px',
				borderRadius: 5,
				border: '1px solid var(--dsh-border-subtle, #d5dae3)',
				background: 'var(--dsh-bg-secondary, #f7f8fa)',
				color: 'inherit',
				cursor: 'pointer',
				font: 'inherit',
			},
			swatch: {
				width: 24,
				height: 24,
				borderRadius: 3,
				border: '1px solid var(--dsh-border-subtle, rgba(0, 0, 0, 0.18))',
				cursor: 'pointer',
				padding: 0,
				boxSizing: 'border-box',
			},
			muted: { opacity: 0.65 },
			canvas: { imageRendering: 'pixelated', cursor: 'crosshair', touchAction: 'none', display: 'block' },
			consoleBox: {
				flex: '0 0 auto',
				borderTop: '1px solid var(--dsh-border-subtle, #e6e9ef)',
				padding: '6px 8px',
				boxSizing: 'border-box',
			},
			consoleInput: {
				flex: '1 1 auto',
				minWidth: 0,
				resize: 'vertical',
				font: '11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
				padding: '3px 6px',
				borderRadius: 5,
				border: '1px solid var(--dsh-border-subtle, #d5dae3)',
				background: 'var(--dsh-bg-secondary, #f7f8fa)',
				color: 'inherit',
				boxSizing: 'border-box',
			},
		};

		function mergeStyle(base, extra) {
			var out = {};
			var key;
			for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
			for (key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
			return out;
		}

		/* ==================================================================== */
		/* The workbench - a first-class left-rail application.                   */
		/*                                                                      */
		/* The right Sidebar hosts "look at this while I talk"; the left rail    */
		/* hosts "this is an app". A pixel editor is the second thing: it keeps  */
		/* its own state, it is not per-conversation, and it wants the whole     */
		/* centre of the window. So the studio registers a sidebar.panellist     */
		/* icon plus a matching 'main' panel, and the right Sidebar keeps only a */
		/* thin shortcut that opens the app.                                     */
		/* ==================================================================== */

		/** Panel id: the left-rail icon id and the 'main' slot key are the same. */
		var APP_PANEL_ID = 'dsh-pixel';

		/** Left-rail glyph: a small inline SVG that still reads at 16px. */
		function PixelGlyph(props) {
			var size = props && typeof props.size === 'number' ? props.size : 18;
			var active = !!(props && props.active);
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 18 18',
					role: 'img',
					'aria-hidden': 'true',
					focusable: 'false',
					style: { display: 'block' },
				},
				h('path', {
					d: 'M1 7.4c3.1-.5 5.5-1.7 8-2.9 2.5 1.2 4.9 2.4 8 2.9-1.5 3.5-4.5 5.6-8 6-3.5-.4-6.5-2.5-8-6Z',
					fill: active ? 'currentColor' : 'none',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinejoin: 'round',
				}),
				h('path', {
					d: 'M4.2 4.6c1.1.5 1.7 1.5 1.9 2.5M13.8 4.6c-1.1.5-1.7 1.5-1.9 2.5',
					stroke: 'currentColor',
					strokeWidth: 1.2,
					strokeLinecap: 'round',
					fill: 'none',
				}),
				h('path', {
					d: 'M9 13.6v1.9',
					stroke: 'currentColor',
					strokeWidth: 1.2,
					strokeLinecap: 'round',
					fill: 'none',
				}),
			);
		}

		/**
		 * Applies a batch of pixel commands to a document as one undoable step.
		 * Pure and synchronous: the same function backs the toolbar, the console
		 * and (through the host queue) the agent, so every path agrees.
		 */
		function applyCommands(doc, commands, layerIndex) {
			if (!doc || !Array.isArray(commands) || commands.length === 0) return { doc: doc, cells: 0 };
			var layers = doc.layers.slice();
			var index = clamp(layerIndex, 0, Math.max(0, layers.length - 1));
			var layer = layers[index];
			if (!layer) return { doc: doc, cells: 0 };
			var rows = (layer.rows || []).slice();
			var cells = 0;

			function write(x, y, ch) {
				if (x < 0 || x >= doc.w || y < 0 || y >= doc.h) return;
				var row = (rows[y] || '').padEnd(doc.w, '.');
				if (row.charAt(x) === ch) return;
				rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
				cells++;
			}

			for (var i = 0; i < commands.length; i++) {
				var command = commands[i];
				if (!command) continue;
				var ch = typeof command.ch === 'string' && command.ch.length > 0 ? command.ch.charAt(0) : '.';
				if (command.kind === 'row') {
					var text = String(command.text || '');
					for (var t = 0; t < text.length; t++) write(command.x + t, command.y, text.charAt(t));
				} else if (command.kind === 'rect') {
					var w = Math.max(1, command.w | 0);
					var hh = Math.max(1, command.h | 0);
					for (var dx = 0; dx < w; dx++) {
						for (var dy = 0; dy < hh; dy++) {
							var filled = command.fill === true;
							var edge = dx === 0 || dy === 0 || dx === w - 1 || dy === hh - 1;
							if (filled || edge) write(command.x + dx, command.y + dy, ch);
						}
					}
				} else if (command.kind === 'line') {
					var steps = Math.max(Math.abs(command.x2 - command.x), Math.abs(command.y2 - command.y));
					for (var s = 0; s <= steps; s++) {
						var px = command.x + Math.round(((command.x2 - command.x) * s) / (steps || 1));
						var py = command.y + Math.round(((command.y2 - command.y) * s) / (steps || 1));
						write(px, py, ch);
					}
				} else if (command.kind === 'fill') {
					var target = (rows[command.y] || '').padEnd(doc.w, '.').charAt(command.x);
					var stack = [[command.x, command.y]];
					var guard = 0;
					while (stack.length > 0 && guard < doc.w * doc.h) {
						var cell = stack.pop();
						var cx = cell[0];
						var cy = cell[1];
						guard++;
						if (cx < 0 || cx >= doc.w || cy < 0 || cy >= doc.h) continue;
						var crow = (rows[cy] || '').padEnd(doc.w, '.');
						if (crow.charAt(cx) !== target || target === ch) continue;
						write(cx, cy, ch);
						stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
					}
				} else {
					write(command.x | 0, command.y | 0, ch);
				}
			}

			if (cells === 0) return { doc: doc, cells: 0 };
			layers[index] = { name: layer.name, visible: layer.visible, rows: rows };
			return {
				doc: {
					id: doc.id,
					name: doc.name,
					w: doc.w,
					h: doc.h,
					palette: doc.palette,
					filePath: doc.filePath,
					layers: layers,
				},
				cells: cells,
			};
		}

		/** Chinese and English verbs, so the console reads like the rest of the app. */
		var VERBS = {
			p: 'pixel', pixel: 'pixel', '点': 'pixel', '像素': 'pixel',
			row: 'row', '行': 'row',
			rect: 'rect', '框': 'rect', '矩形': 'rect',
			line: 'line', '线': 'line',
			fill: 'fill', '填': 'fill', '填充': 'fill',
		};

		/** Resolves a console colour token to a palette slot index. */
		function resolveSlot(token, palette) {
			if (token === undefined) return -1;
			var text = String(token).trim();
			if (/^[0-9]+$/.test(text)) {
				var index = parseInt(text, 10);
				return index >= 0 && index < palette.length ? index : -1;
			}
			if (text.charAt(0) === '#') {
				var found = palette.indexOf(text.toLowerCase());
				if (found < 0) found = palette.indexOf(text.toUpperCase());
				return found;
			}
			return -1;
		}

		/**
		 * Parses one line of the console into a command, or returns null when the
		 * line is not a directive (so the caller can treat it as a request).
		 */
		function parseCommand(line, palette) {
			var text = String(line || '').trim();
			if (text === '') return null;
			var lower = text.toLowerCase();
			if (lower === 'clear' || text === '清空') return { kind: 'clear' };
			var parts = text.split(/\s+/);
			var verb = VERBS[parts[0].toLowerCase()] || VERBS[parts[0]];
			if (!verb) return null;
			var args = parts.slice(1);
			var command = { kind: verb };
			if (verb === 'pixel') {
				if (args.length < 3) return null;
				command.x = parseInt(args[0], 10);
				command.y = parseInt(args[1], 10);
				command.ch = args[2];
				return command;
			}
			if (verb === 'row') {
				if (args.length < 3) return null;
				command.x = parseInt(args[0], 10);
				command.y = parseInt(args[1], 10);
				command.text = args.slice(2).join('');
				return command;
			}
			if (verb === 'rect') {
				if (args.length < 5) return null;
				command.x = parseInt(args[0], 10);
				command.y = parseInt(args[1], 10);
				command.w = parseInt(args[2], 10);
				command.h = parseInt(args[3], 10);
				command.ch = args[4];
				command.fill = args[5] === 'fill' || args[5] === '填';
				return command;
			}
			if (verb === 'line') {
				if (args.length < 5) return null;
				command.x = parseInt(args[0], 10);
				command.y = parseInt(args[1], 10);
				command.x2 = parseInt(args[2], 10);
				command.y2 = parseInt(args[3], 10);
				command.ch = args[4];
				return command;
			}
			if (verb === 'fill') {
				if (args.length < 3) return null;
				command.x = parseInt(args[0], 10);
				command.y = parseInt(args[1], 10);
				command.ch = args[2];
				return command;
			}
			return null;
		}

		/** Small console beneath the canvas: type a directive, or hand the request to the agent. */
		function PixelConsole(props) {
			var [text, setText] = useState('');
			var [note, setNote] = useState('');
			var palette = props.palette || [];
			var doc = props.doc;

			var submit = function () {
				var raw = text.trim();
				if (raw === '' || !doc) return;
				var lines = raw.split('\n');
				var commands = [];
				var passthrough = [];
				for (var i = 0; i < lines.length; i++) {
					var line = lines[i];
					if (line.trim() === '') continue;
					var parsed = parseCommand(line, palette);
					if (!parsed) {
						passthrough.push(line);
						continue;
					}
					if (parsed.kind === 'clear') {
						for (var y = 0; y < doc.h; y++) {
							commands.push({ kind: 'row', x: 0, y: y, ch: '.', text: new Array(doc.w + 1).join('.') });
						}
						continue;
					}
					var slot = resolveSlot(parsed.ch, palette);
					if (slot < 0) {
						passthrough.push(line);
						continue;
					}
					parsed.ch = CHARS.charAt(slot);
					commands.push(parsed);
				}
				if (commands.length > 0) {
					props.onApply(commands);
					setNote('已执行 ' + commands.length + ' 条指令');
				} else {
					setNote('没有可执行的指令');
				}
				if (passthrough.length > 0) {
					props.onAsk(passthrough.join(String.fromCharCode(10)));
					setNote('已交给 ' + BRAND.assistant);
				}
				setText('');
			};

			return h(
				'div',
				{ style: S.consoleBox },
				h('div', { style: mergeStyle(S.muted, { fontSize: 11, marginBottom: 3 }) }, '指令台'),
				h('div', { style: { display: 'flex', gap: 4, alignItems: 'stretch' } },
					h('textarea', {
						value: text,
						placeholder: 'p 12 8 3   ·   rect 4 4 10 6 1   ·   fill 9 9 2   ·   自然语言会交给 ' + BRAND.assistant,
						rows: 2,
						onChange: function (event) { setText(event.target.value); },
						onKeyDown: function (event) {
							if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								submit();
							}
						},
						style: S.consoleInput,
					}),
					h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
						h('button', { type: 'button', style: S.button, onClick: submit, title: 'Ctrl+Enter' }, '执行'),
						h('button', { type: 'button', style: S.button, onClick: function () { setText(''); setNote(''); } }, '清空'),
					),
				),
				h('div', { style: mergeStyle(S.muted, { fontSize: 11, marginTop: 3 }) },
					note || '坐标从左上角 (0,0) 开始；颜色写色板序号或 #hex。',
				),
			);
		}

		/* ------------------------------------------------------------------ */
		/* panel                                                               */
		/* ------------------------------------------------------------------ */

		function PixelPanel(props) {
			var sessionId =
				typeof props.sessionId === 'string' && props.sessionId !== ''
					? props.sessionId
					: props.scope && props.scope.sessionId
						? props.scope.sessionId
						: '';
			var visible = props.visible !== false;


			var [docs, setDocs] = useState([]);
			var [doc, setDoc] = useState(null);
			var [tool, setTool] = useState('pencil');
			var [slot, setSlot] = useState(6);
			var [zoom, setZoom] = useState(8);
			var [layerIndex, setLayerIndex] = useState(0);
			var [grid, setGrid] = useState(true);
			var [symmetry, setSymmetry] = useState(false);
			var [status, setStatus] = useState('');
			var [busy, setBusy] = useState(false);
			var canvasRef = useRef(null);
			var paintingRef = useRef(false);
			var undoRef = useRef([]);

			var refreshList = useCallback(function () {
				return call('list')
					.then(function (json) {
						setDocs(json.docs || []);
					})
					.catch(function (error) {
						setStatus('列表读取失败：' + error.message);
					});
			}, []);

			useEffect(function () {
				if (!visible) return;
				refreshList();
			}, [visible, refreshList]);

			useEffect(
				function () {
					if (!doc || !visible) return;
					paintCanvas(canvasRef.current, doc, zoom, { grid: grid, symmetry: symmetry });
				},
				[doc, zoom, grid, symmetry, visible],
			);

			var openWork = useCallback(function (id) {
				setBusy(true);
				call('get', { id: id })
					.then(function (json) {
						setDoc(json.doc);
						setLayerIndex(0);
						undoRef.current = [];
						setStatus('');
					})
					.catch(function (error) {
						setStatus('打开失败：' + error.message);
					})
					.then(function () {
						setBusy(false);
					});
			}, []);

			var applyEdit = useCallback(
				function (x, y, value) {
					setDoc(function (previous) {
						if (!previous) return previous;
						var layers = previous.layers.slice();
						var index = clamp(layerIndex, 0, layers.length - 1);
						var layer = layers[index];
						var rows = layer.rows.slice();
						var row = rows[y] || '';
						row = row.padEnd(previous.w, '.');
						var next = row.slice(0, x) + value + row.slice(x + 1);
						if (next === row) return previous;
						rows[y] = next;
						layers[index] = { name: layer.name, visible: layer.visible, rows: rows };
						var copy = {
							id: previous.id,
							name: previous.name,
							w: previous.w,
							h: previous.h,
							palette: previous.palette,
							filePath: previous.filePath,
							layers: layers,
						};
						return copy;
					});
				},
				[layerIndex],
			);

			var pixelAt = useCallback(
				function (event) {
					var canvas = canvasRef.current;
					if (!canvas || !doc) return null;
					var rect = canvas.getBoundingClientRect();
					var scaleX = doc.w * zoom === 0 ? 1 : rect.width / (doc.w * zoom);
					var scaleY = doc.h * zoom === 0 ? 1 : rect.height / (doc.h * zoom);
					var x = Math.floor(((event.clientX - rect.left) / scaleX / zoom) * 1);
					var y = Math.floor(((event.clientY - rect.top) / scaleY / zoom) * 1);
					if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return null;
					return [x, y];
				},
				[doc, zoom],
			);

			var stroke = useCallback(
				function (event) {
					var point = pixelAt(event);
					if (!point || !doc) return;
					var value;
					if (tool === 'eraser') value = '.';
					else if (tool === 'picker') {
						var layers = doc.layers;
						var index = clamp(layerIndex, 0, layers.length - 1);
						var row = (layers[index].rows || [])[point[1]] || '';
						var ch = row.charAt(point[0]);
						var picked = CHARS.indexOf(ch);
						if (picked >= 0) setSlot(picked);
						setTool('pencil');
						return;
					} else {
						value = CHARS.charAt(slot);
					}
					applyEdit(point[0], point[1], value);
					if (symmetry && doc.w % 2 === 0) {
						var mirror = doc.w - 1 - point[0];
						if (mirror !== point[0]) applyEdit(mirror, point[1], value);
					}
				},
				[applyEdit, doc, layerIndex, pixelAt, slot, symmetry, tool],
			);

			var onPointerDown = useCallback(
				function (event) {
					if (!visible || !doc) return;
					event.preventDefault();
					paintingRef.current = true;
					if (event.currentTarget && event.currentTarget.setPointerCapture) {
						try {
							event.currentTarget.setPointerCapture(event.pointerId);
						} catch (error) {
							// Pointer capture is an optimisation only.
						}
					}
					stroke(event);
				},
				[doc, stroke, visible],
			);

			var onPointerMove = useCallback(
				function (event) {
					if (!paintingRef.current) return;
					stroke(event);
				},
				[stroke],
			);

			var onPointerUp = useCallback(function () {
				paintingRef.current = false;
			}, []);

			var save = useCallback(
				function () {
					if (!doc) return;
					setBusy(true);
					call('save', { doc: doc })
						.then(function (json) {
							setDoc(json.doc);
							setStatus('已保存 ' + json.doc.w + '×' + json.doc.h);
							return refreshList();
						})
						.catch(function (error) {
							setStatus('保存失败：' + error.message);
						})
						.then(function () {
							setBusy(false);
						});
				},
				[doc, refreshList],
			);

			var exportAt = useCallback(
				function (scale) {
					if (!doc) return;
					setBusy(true);
					exportCall('export', { doc: withSlug(doc), scale: scale, sessionId: sessionId })
						.then(function (json) {
							var last = json.written[json.written.length - 1];
							setStatus('已写出 ' + last.width + '×' + last.height + ' → ' + last.path);
						})
						.catch(function (error) {
							setStatus('导出失败：' + error.message);
						})
						.then(function () {
							setBusy(false);
						});
				},
				[doc, sessionId],
			);

			var exportAll = useCallback(
				function () {
					if (!doc) return;
					setBusy(true);
					exportCall('export', { doc: withSlug(doc), sessionId: sessionId })
						.then(function (json) {
							var written = json.written || [];
							setStatus(
								'已写出 ' + written.length + ' 档：' + written[0].width + ' … ' + written[written.length - 1].width + ' px → ' + json.directory,
							);
						})
						.catch(function (error) {
							setStatus('整档导出失败：' + error.message);
						})
						.then(function () {
							setBusy(false);
						});
				},
				[doc, sessionId],
			);

			var createWork = useCallback(
				function (size, name) {
					setBusy(true);
					var palette = doc && doc.palette ? doc.palette : ['#071321', '#112a46', '#1a4670', '#2a6c9c', '#50a0c6', '#aae9ee', '#fafdff', '#ff8aa4'];
					call('create', { w: size, h: size, name: name, palette: palette })
						.then(function (json) {
							setDoc(json.doc);
							setLayerIndex(0);
							return refreshList();
						})
						.catch(function (error) {
							setStatus('新建失败：' + error.message);
						})
						.then(function () {
							setBusy(false);
						});
				},
				[doc, refreshList],
			);
			/** Applies a batch of console or agent commands as one undoable step. */
			var applyBatch = useCallback(
				function (commands) {
					var applied = 0;
					setDoc(function (previous) {
						var result = applyCommands(previous, commands, layerIndex);
						applied = result.cells;
						return result.doc;
					});
					setStatus(applied > 0 ? '已修改 ' + applied + ' 像素' : '没有像素变化');
					return applied;
				},
				[layerIndex],
			);

			/**
			 * Hands a natural-language request to the user's own Session: the workbench
			 * never calls a model itself, it writes the request into the composer,
			 * so the edit goes through the normal tool loop and stays auditable.
			 */
			var askAgent = useCallback(
				function (request) {
					if (!request) return;
					var text = BRAND.requestTag + ' ' + request;
					/*
					 * A client plugin cannot call a model, so the request is handed to the
					 * user's own Session instead: opening the Conversation with the request
					 * as the initial draft keeps the edit inside the normal tool loop.
					 * `uiWorkspace` owns that action; `layout` only selects panels.
					 */
					var workspace = PIXEL_HOST.workspace;
					if (workspace && typeof workspace.startSession === 'function') {
						/*
						 * Order matters: `layout.selectPanel` aborts the pending navigation a
						 * Session switch registers, so the panel must be released first or the
						 * Conversation opens without the request. Null means "Conversation".
						 */
						openConversation();
						try {
							workspace.startSession(undefined, { prompt: text, whenDraftExists: 'append' });
						} catch (error) {
							setStatus('对话入口不可用：' + error.message);
							return;
						}
						setStatus('已交给 ' + BRAND.assistant + '，可在对话里继续描述');
						return;
					}
					setStatus('这里还没接通对话，先把指令写成色板序号或 #hex 试试');
				},
				[props],
			);

			var toggleLayer = useCallback(function (index) {
				setDoc(function (previous) {
					if (!previous) return previous;
					var layers = previous.layers.map(function (layer, position) {
						if (position !== index) return layer;
						return { name: layer.name, visible: layer.visible === false, rows: layer.rows };
					});
					var copy = {
						id: previous.id,
						name: previous.name,
						w: previous.w,
						h: previous.h,
						palette: previous.palette,
						filePath: previous.filePath,
						layers: layers,
					};
					return copy;
				});
			}, []);

			var palette = doc && doc.palette ? doc.palette : [];
			var layers = doc && doc.layers ? doc.layers : [];
			var activeLayer = layers[clamp(layerIndex, 0, Math.max(0, layers.length - 1))];

			var list = docs.map(function (entry) {
				return h(
					'button',
					{
						key: entry.id,
						type: 'button',
						style: mergeStyle(S.item, doc && doc.id === entry.id ? S.itemActive : {}),
						onClick: function () {
							openWork(entry.id);
						},
						title: entry.id + ' · ' + entry.colors + ' 色 · ' + entry.layers + ' 层',
					},
					h('span', { style: { display: 'block', fontWeight: 600 } }, entry.name),
					h('span', { style: mergeStyle(S.muted, { display: 'block', fontSize: 11 }) }, entry.w + '×' + entry.h),
				);
			});

			var scaleRow = SCALES.map(function (scale) {
				var side = doc ? doc.w * scale : 0;
				return h(
					'button',
					{
						key: scale,
						type: 'button',
						style: mergeStyle(S.button, { width: '100%', marginBottom: 3, fontSize: 11 }),
						onClick: function () {
							exportAt(scale);
						},
						disabled: busy || !doc,
						title: '整数倍 ' + scale + '× → ' + side + 'px',
					},
					scale + '× · ' + side,
				);
			});

			var swatches = palette.map(function (hex, index) {
				return h('button', {
					key: hex + index,
					type: 'button',
					title: hex,
					style: mergeStyle(S.swatch, {
						background: hex,
						borderColor: 'transparent',
						outline: slot === index ? '2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2a6c9c)' : 'none',
						outlineOffset: 1,
					}),
					onClick: function () {
						setSlot(index);
						setTool('pencil');
					},
				});
			});

			return h(
				'div',
				{ style: S.root },
				h(
					'div',
					{ style: S.bar },
					h('strong', { style: { marginRight: 4 } }, BRAND.short),
					h(
						'button',
						{ type: 'button', style: S.button, disabled: busy || !doc, onClick: save, title: '保存到作品库' },
						'保存',
					),
					h(
						'button',
						{ type: 'button', style: S.button, disabled: busy || !doc, onClick: exportAll, title: '导出全部整数倍尺寸' },
						'导出整档',
					),
					h(
						'label',
						{ style: { display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 } },
						'缩放',
						h('input', {
							type: 'range',
							min: 1,
							max: 24,
							value: zoom,
							style: { width: 70 },
							onChange: function (event) {
								setZoom(clamp(Number(event.target.value) || 8, 1, 24));
							},
						}),
						h('span', { style: S.muted }, zoom + '×'),
					),
					h(
						'label',
						{ style: { display: 'flex', alignItems: 'center', gap: 3 } },
						h('input', { type: 'checkbox', checked: grid, onChange: function (event) { setGrid(event.target.checked); } }),
						'网格',
					),
					h(
						'label',
						{ style: { display: 'flex', alignItems: 'center', gap: 3 } },
						h('input', {
							type: 'checkbox',
							checked: symmetry,
							onChange: function (event) {
								setSymmetry(event.target.checked);
							},
						}),
						'镜像',
					),
				),
				h(
					'div',
					{ style: S.body },
					h(
						'div',
						{ style: S.rail },
						h('div', { style: mergeStyle(S.muted, { fontSize: 11, marginBottom: 4 }) }, '作品库'),
						list.length > 0 ? list : h('div', { style: S.muted }, '暂无作品'),
						h(
							'div',
							{ style: { marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' } },
							h(
								'button',
								{ type: 'button', style: S.button, disabled: busy, onClick: function () { createWork(48, BRAND.short + ' 48'); } },
								'新建 48',
							),
							h(
								'button',
								{ type: 'button', style: S.button, disabled: busy, onClick: function () { createWork(32, BRAND.short + ' 32'); } },
								'新建 32',
							),
						),
					),
					h(
						'div',
						{ style: S.stage },
						doc
							? h('canvas', {
									ref: canvasRef,
									style: S.canvas,
									onPointerDown: onPointerDown,
									onPointerMove: onPointerMove,
									onPointerUp: onPointerUp,
									onPointerCancel: onPointerUp,
									onPointerLeave: onPointerUp,
								})
							: h('div', { style: mergeStyle(S.muted, { padding: 24, textAlign: 'center' }) }, '左侧选一件作品开始编辑'),
					),
					h(
						'div',
						{ style: S.side },
						h('div', { style: mergeStyle(S.muted, { fontSize: 11, marginBottom: 4 }) }, '工具'),
						h(
							'div',
							{ style: { display: 'flex', gap: 3, marginBottom: 8, flexWrap: 'wrap' } },
							['pencil', 'eraser', 'picker'].map(function (name) {
								var label = name === 'pencil' ? '画' : name === 'eraser' ? '擦' : '吸';
								return h(
									'button',
									{
										key: name,
										type: 'button',
										style: mergeStyle(S.button, { padding: '2px 6px', background: tool === name ? 'rgba(42,108,156,0.2)' : undefined }),
										onClick: function () {
											setTool(name);
										},
									},
									label,
								);
							}),
						),
						h('div', { style: mergeStyle(S.muted, { fontSize: 11, marginBottom: 4 }) }, '色板'),
						h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3 } }, swatches),
						h('div', { style: mergeStyle(S.muted, { fontSize: 11, margin: '8px 0 4px' }) }, '图层'),
						layers.map(function (layer, index) {
							return h(
								'button',
								{
									key: index,
									type: 'button',
									style: mergeStyle(S.item, { padding: '2px 4px', fontSize: 11, background: index === layerIndex ? 'rgba(42,108,156,0.14)' : undefined }),
									onClick: function () {
										setLayerIndex(index);
									},
									onDoubleClick: function () {
										toggleLayer(index);
									},
									title: '双击切换可见性',
								},
								(layer.visible === false ? '○ ' : '● ') + layer.name,
							);
						}),
						h('div', { style: mergeStyle(S.muted, { fontSize: 11, margin: '8px 0 4px' }) }, '整数倍导出'),
						scaleRow,
					),
				),
				h(
					PixelConsole,
					{
						doc: doc,
						palette: palette,
						onApply: applyBatch,
						onAsk: askAgent,
					},
				),
				h(
					'div',
					{
						style: {
							flex: '0 0 auto',
							padding: '4px 8px',
							borderTop: '1px solid var(--dsh-border-subtle, #e6e9ef)',
							fontSize: 11,
							minHeight: 18,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
						},
						title: status,
					},
					status || (doc ? doc.name + ' · ' + doc.w + '×' + doc.h + (activeLayer ? ' · ' + activeLayer.name : '') : '就绪'),
				),
			);
		}

		var clientName = 'dsh-pixel';

		/**
		 * Display brand for THIS instance.
		 *
		 * The plugin is generic (id, route, module id); the IP it serves is data.
		 * To retarget the workbench at another IP, edit this object and the
		 * matching slugs on the Host side -- nothing else spells a brand.
		 */
		var BRAND = {
			app: 'MANTA Studio',
			short: 'MANTA',
			assistant: 'MANTA 助手',
			slug: 'manta-mark',
			requestTag: '[MANTA Studio]',
		};

		/** The right Sidebar's page kind. The app lives in the rail; this is a shortcut. */
		var PIXEL_KIND = 'pixel-ip';

		/** Registry identity, and the key the shortcut seats register under. */
		var PIXEL_TAB_ID = 'dsh-pixel/studio';

		/**
		 * The two client services the app needs, captured once in apply().
		 *
		 * They are separate services with separate owners: `ctx.layout` selects the
		 * central panel, while opening a Conversation with initial content is
		 * `ctx.uiWorkspace.startSession`. Reading either is guarded because cordis
		 * proxies throw on undeclared service keys, and an absent service must
		 * degrade the assistant hand-off rather than the whole studio.
		 */
		var PIXEL_HOST = { layout: null, workspace: null };

		/** Reads a service, or null when this composition does not declare it. */
		function guardedService(ctx, name) {
			try {
				return ctx.get(name) || null;
			} catch (error) {
				return null;
			}
		}

		/** Brings the app to the front; a no-op when this composition has no layout. */
		function openStudio() {
			var layout = PIXEL_HOST.layout;
			if (!layout || typeof layout.selectPanel !== 'function') return;
			try {
				layout.selectPanel(APP_PANEL_ID);
			} catch (error) {
				/* The main key is registered by this same plugin, so this only fires
				 * during teardown; swallowing it keeps the shortcut from throwing. */
			}
		}

		/** Leaves the rail page so the Conversation is visible. */
		function openConversation() {
			var layout = PIXEL_HOST.layout;
			if (!layout || typeof layout.selectPanel !== 'function') return;
			try {
				layout.selectPanel(null);
			} catch (error) {
				/* Nothing to recover: the request is already in the Session draft. */
			}
		}

		/** The chip beside the shortcut's own glyph. */
		function PixelTitle() {
			return h('span', null, BRAND.short);
		}


		/** The studio page. Full-width, because it is an app and not a peek panel. */
		function PixelStudioPage(props) {
			return h(
				'div',
				{ style: S.root, 'data-dsh-pixel-app': 'studio' },
				h(PixelPanel, { visible: true, host: props.host, sessionId: props.sessionId }),
			);
		}

		/** The right-Sidebar shortcut: a one-line card that jumps to the app. */
		function PixelShortcut(props) {
			return h(
				'div',
				{ style: { padding: 12, fontSize: 12 } },
				h('div', { style: { fontWeight: 600, marginBottom: 4 } }, BRAND.app),
				h(
					'div',
					{ style: mergeStyle(S.muted, { marginBottom: 8 }) },
					'像素标记工作台已经移到左侧任务栏，作为一个独立小应用运行。',
				),
				h(
					'button',
					{
						type: 'button',
						style: S.button,
						onClick: function () {
						openStudio();
					},
					},
					'打开 ' + BRAND.app,
				),
			);
		}

		return {
			name: clientName,
			/*
			 * 'slots' for the rail icon and the app page, 'sidebarRightTabs' only for
			 * the shortcut that points at the app. Both live in the core profile, so
			 * nothing here depends on a package that might be absent.
			 */
			inject: ['slots', 'sidebarRightTabs', 'layout', 'uiWorkspace'],
			apply: function apply(ctx) {
				/*
				 * A slot component receives only its projection props, so the two
				 * services are captured here, off the plugin context. Both are declared
				 * in `inject`, which is what makes them readable at all: cordis throws on
				 * an undeclared service key. The lookup stays guarded so a version skew
				 * degrades the assistant hand-off instead of the whole studio.
				 */
				PIXEL_HOST.layout = guardedService(ctx, 'layout');
				PIXEL_HOST.workspace = guardedService(ctx, 'uiWorkspace');

				/* ---- the app itself: a left-rail icon plus a full page ---- */
				ctx.effect(function () {
					return ctx.slots.inject('sidebar.panellist', function () {
						return ctx.slots.register(
							{
								name: 'sidebar.panellist',
								id: APP_PANEL_ID,
								order: 60,
								label: function () {
									return BRAND.short;
								},
							},
							PixelGlyph,
						);
					});
				}, 'dsh-pixel: left rail icon');

				ctx.effect(function () {
					return ctx.slots.inject('main', function () {
						return ctx.slots.register(
							{
								name: 'main',
								key: APP_PANEL_ID,
								inject: function () {
									return { host: PIXEL_HOST };
								},
							},
							PixelStudioPage,
						);
					});
				}, 'dsh-pixel: studio page');

				/* ---- the shortcut, so the right Sidebar can still find it ---- */
				ctx.effect(function () {
					return ctx.sidebarRightTabs.register({
						id: PIXEL_TAB_ID,
						kind: PIXEL_KIND,
						priority: 'extension',
						title: function () {
							return BRAND.short;
						},
						guide: [
							{
								id: 'studio',
								order: 60,
								title: function () {
									return BRAND.app;
								},
								description: function () {
									return '像素标记工作台（左侧任务栏）';
								},
							},
						],
					});
				}, 'dsh-pixel: right Sidebar tab type');

				ctx.effect(function () {
					return ctx.slots.inject('sidebar.right.pane.tab', function () {
						return ctx.slots.register(
							{
								name: 'sidebar.right.pane.tab',
								key: PIXEL_TAB_ID,
							},
							PixelShortcut,
						);
					});
				}, 'dsh-pixel: right Sidebar shortcut');

				ctx.effect(function () {
					return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
						return ctx.slots.register(
							{
								name: 'sidebar.right.pane.tab.title',
								key: PIXEL_TAB_ID,
							},
							PixelTitle,
						);
					});
				}, 'dsh-pixel: right Sidebar shortcut title');
			},
		};
	},
});
