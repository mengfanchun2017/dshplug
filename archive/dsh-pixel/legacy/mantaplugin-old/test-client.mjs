import fs from "node:fs";

// ---- minimal React stand-in: enough to evaluate the bundle and render-check it ----
let hookCursor = 0;
const hookStore = new Map();
function useHook(slot, initial) {
  const key = slot;
  if (!hookStore.has(key)) hookStore.set(key, { value: initial });
  return hookStore.get(key);
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const h = useHook(hookCursor++, typeof initial === "function" ? initial() : initial);
    return [h.value, (n) => { h.value = typeof n === "function" ? n(h.value) : n; }];
  },
  useEffect() {}, useLayoutEffect() {},
  useRef(v) { const h = useHook(hookCursor++, v); return h.value; },
  useCallback(fn) { return fn; }, useMemo(fn) { return fn(); }, memo: (c) => c,
};
function resetHooks() { hookCursor = 0; hookStore.clear(); }

let loaded = null;
globalThis.window = { __ModuleLoader__: { load(record) { loaded = record; } } };

const src = fs.readFileSync("C:/dsh/mantaplugin/plugin/client.js", "utf8");
const fn = new Function("require", "window", "document", src);
const req = (name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
};
fn(req, globalThis.window, {});
resetHooks();

const report = {};
report.loadedId = loaded && loaded.id;
report.hasFactory = loaded && typeof loaded.factory === "function";

const plugin = loaded.factory(req);
report.pluginName = plugin.name;
report.inject = plugin.inject;
report.hasApply = typeof plugin.apply === "function";

// ---- a Context stand-in carrying the two core services the plugin injects ----
const tabTypes = [];
const slots = new Map();
const effects = [];
const selected = [];
const started = [];
const ctx = {
  effect(fn, label) { effects.push(label); const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
  sidebarRightTabs: {
    register(definition) { tabTypes.push(definition); return () => { const i = tabTypes.indexOf(definition); if (i >= 0) tabTypes.splice(i, 1); }; },
  },
  layout: { selectPanel(panelId) { selected.push(panelId); } },
  uiWorkspace: { startSession(workspaceId, options) { started.push({ workspaceId, options }); } },
  slots: {
    inject(name, contribute) {
      if (!slots.has(name)) slots.set(name, []);
      const dispose = contribute();
      slots.get(name).push(dispose);
      return () => { const list = slots.get(name); const i = list.indexOf(dispose); if (i >= 0) list.splice(i, 1); };
    },
    register(definition, Component) {
      const entry = { definition, Component };
      if (!slots.has("__entries")) slots.set("__entries", []);
      slots.get("__entries").push(entry);
      return () => { const list = slots.get("__entries"); const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); };
    },
  },
};
plugin.apply(ctx);

report.effects = effects;
report.selected = selected;
report.started = started;
report.tabTypes = tabTypes.map((t) => ({
  id: t.id, kind: t.kind, priority: t.priority, title: t.title(),
  guide: (t.guide || []).map((g) => ({ id: g.id, order: g.order, title: g.title(), description: g.description() })),
}));

const entries = (slots.get("__entries") || []).map((e) => ({
  seat: e.definition.name,
  key: e.definition.key,
  componentName: e.Component && (e.Component.name || "(anonymous)"),
}));
report.slotEntries = entries;

// The rail icon: the sidebar hands it { size, active } and expects a glyph.
const glyph = (slots.get("__entries") || []).find((e) => e.definition.name === "sidebar.panellist");
resetHooks();
const glyphIdle = glyph.Component({ size: 18, active: false });
const glyphActive = glyph.Component({ size: 16, active: true });
report.glyph = {
  type: glyphIdle && glyphIdle.type,
  viewBox: glyphIdle && glyphIdle.props && glyphIdle.props.viewBox,
  paths: glyphIdle && glyphIdle.children ? glyphIdle.children.length : 0,
  activeFill: glyphActive && glyphActive.children && glyphActive.children[0].props.fill,
  idleFill: glyphIdle && glyphIdle.children && glyphIdle.children[0].props.fill,
  activeSize: glyphActive && glyphActive.props && glyphActive.props.width,
};

// The app page: the 'main' seat renders the studio full-width.
const page = (slots.get("__entries") || []).find((e) => e.definition.name === "main");
resetHooks();
const pageEl = page.Component({ host: null, sessionId: "s1" });
report.page = {
  seat: page.definition.name,
  key: page.definition.key,
  rootType: pageEl && pageEl.type,
  marker: pageEl && pageEl.props && pageEl.props["data-manta-app"],
  children: pageEl && pageEl.children ? pageEl.children.length : 0,
};

// The body must render with the props the core seat injects (sessionId, useTabInfo, ...).
const body = (slots.get("__entries") || []).find((e) => e.definition.name === "sidebar.right.pane.tab");
resetHooks();
const useTabInfo = () => ({ tab: { id: "t1", visible: true } });
const element = body.Component({ sessionId: "s1", useTabInfo, visible: true, active: true, t: (k) => k });
report.renders = Boolean(element) && typeof element === "object";
report.rootType = element && element.type;
report.childCount = element && element.children ? element.children.length : 0;
report.shortcutIsCard = Boolean(element && element.type === "div");

const title = (slots.get("__entries") || []).find((e) => e.definition.name === "sidebar.right.pane.tab.title");
resetHooks();
const titleEl = title.Component({ useTabInfo });
report.titleElement = Boolean(titleEl) && typeof titleEl === "object";
report.titleChildText = titleEl && titleEl.children ? JSON.stringify(titleEl.children) : null;

console.log(JSON.stringify(report, null, 2));
