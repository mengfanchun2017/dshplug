# @local/dsh-preview-editor

Edit workspace text files **in place** from the right Sidebar's document preview: open a file,
type, press `Ctrl+S`, and the bytes land on disk through the same sandbox the file tools use.

This is a locally authored plugin. It ships both halves:

| Half | File | What it does |
|---|---|---|
| Host | `index.js` | Claims one exact Fetch route, `/api/dsh-preview-editor`, on the Connection `/api` bridge and performs `ctx.fs` reads and writes under the requesting Session's standing sandbox policy. |
| Client | `client.js` | Registers the **`Edit`** document-preview renderer and a keyed body for `sidebar.right.tab.document` that renders a textarea over the file's exact text, with the platform's syntax colours, a measured line-number gutter, and in-place marks for invisible characters painted in a layer beneath it. |

## Why it is built this way

- **Transport.** The browser's Remote surface is fixed at build time, and no shipped Remote method
  writes a file. The Connection package, however, exposes a Host-side registry of *exact Fetch
  routes* (`ctx.connection.fetch.register`) under its single `/api` prefix. A route claimed there
  inherits the shipped browser cookie authentication and the Host/Origin fence, so the plugin needs
  no credential scheme of its own and adds no Remote surface.
- **Sandbox.** The route resolves the requesting Session and passes `ctx.sandboxPolicy.resolve({ session })`
  to `ctx.fs`, exactly as `dsh-tool-fs` does. `workspace-write` Sessions may edit only what their own
  tools may write, `read-only` refuses, `danger-full-access` is unfenced. A cold or unknown Session is
  refused rather than silently fenced to the deployment default.
- **Conflicts.** Reads return the target's observed version; saves pass `{ kind: 'replaceIfVersion', version }`,
  so a file changed elsewhere fails with `FS_STALE_VERSION` ("文件已被外部修改") instead of being
  clobbered.
- **Line endings.** The buffer holds `LF` because a `<textarea>` would otherwise normalize CRLF away;
  the file's dominant ending is remembered on read and restored on save, so a CRLF file stays CRLF.

## Install into a profile

The profile owns plugin installation, so installing needs writes outside the
session workspace (`~/.dsh/profiles/<name>/`).

The Web **Plugins** page's install field validates the spec against the registry, so it refuses a
local directory (`not a package name the registry accepts`); it is for published packages. Install a
local package through the profile's own package manager instead, then register the bundle:

```bash
dsh plugin --profile desktop add "C:/Users/franc/Documents/deepseek-harness/default-workspace/dsh-preview-editor"
```

That links the package and records it under `dependencies`. Then append the name to the profile's
ordered bundle list in `~/.dsh/profiles/desktop/package.json`:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-preview-editor"] } }
```

Appending matters: bundle patches apply in list order, so the last entry wins.

A running app picked the row up without a restart: a `--dump-config` equivalent confirmed the patch
composes, and the live check below showed the client bundle served. The **page** must be reloaded for
the browser to read the new boot graph.

## Verify

```bash
node verify.mjs        # host route + client bundle, dependency-free, no app needed
node verify-live.mjs   # asks the RUNNING app whether it serves this package's bundle
```

`verify.mjs` runs the Host route end to end against a real filesystem (CRLF round trip, version
guard, every refusal path) and loads the Client bundle through a stand-in `__ModuleLoader__`
(registration, config resolution, and a hook-shim render of the body). It runs **36 checks**; the
newest ones cover the gutter, the invisible-character marks, the LF/CRLF/no-EOL marks, the separate
switches, the mark size cap, the viewer priority bands, and — most importantly — **the initial
loading render**.

> **The blank-Edit bug (1.0.2 → 1.0.4).** Adding the gutter introduced
> `rowCount(draft.text)` above the return tree. On the very first render `draft` is
> `{ status: 'loading' }` with **no `text`**, so `undefined.split('\n')` threw. React then never
> committed the effect that starts the read, and the pane stayed empty forever. The offline suite
> had only ever seeded the `ready` state, so it could not see this. `rowCount` now tolerates a
> missing buffer, the body returns a visible loading state before `text` exists, and a regression
> test renders the initial state with no seed at all. **Rule: never call a string method on
> `draft.text` outside a `status === 'ready'` guard.**

`verify-live.mjs` reproduces the artifact revision of `client.js` and fetches the bundle from
`/plugins/...`: only a row in the running composition is served, so a 200 is evidence the install is
live rather than merely written to disk. It also matches **9 code markers**, including
`data-preview-editor-line` / `data-preview-editor-gutter` from the gutter work, so a bundle predating
that change cannot pass. Its URL comes from the first argument or `DSH_WEB_URL`; the Desktop GUI's
port changes on every launch, so pass the current URL explicitly.

### Route-level check against a throwaway instance

`/api` admits nothing before authentication, so a *running* GUI cannot be probed for whether a route
is claimed. Boot a second instance on another port and hold its own credential instead — the token
comes from the process you started, and `/connect` exchanges it for an API cookie:

```bash
dsh <profile-with-this-bundle> --port 0 --no-open      # prints http://127.0.0.1:<port>/?token=…
```

```bash
curl -c jar -i "http://127.0.0.1:<port>/connect?token=<token>&interactions=answer"   # 302 + dsh-auth cookie

curl -b jar -H 'content-type: application/json' -d '{"op":"read","sessionId":"deadbeef","path":"x"}' \
  http://127.0.0.1:<port>/api/dsh-preview-editor
# {"ok":false,"code":"FS_NO_SESSION","message":"session deadbeef is not live in this process"}
```

The replies separate the layers, which is the point:

| probe | meaning |
| --- | --- |
| no cookie | `401 unauthorized` — the shipped admission fence, not mine |
| cookie, claimed path | `200` with this plugin's JSON — route claimed and handler running |
| cookie, other path | `404 not found` — unclaimed routes are absent, so the 200 above is specific |
| cookie, body `not json` | `200` `E_BAD_REQUEST` — this plugin's own validation |
| `GET /` with the token | the boot graph lists `@local/dsh-preview-editor/client.js`, and the index carries `globalThis["__DSH_PREVIEW_EDITOR_CONFIG__"]` — the Host half ran and its config reached the page |

A fresh instance has no live Session, so `FS_NO_SESSION` is the expected success here; a real save
needs a Session that is live *in that process*, which the GUI provides and a bare instance does not.

## Configuration

The row config is read by both halves — but they receive it differently, because a client bundle's
boot-graph row carries its identity, ordering, and externals only, never its config. So the Host
half reproduces what the shipped preview packages do: it embeds the row config in every index
response as `globalThis.__DSH_PREVIEW_EDITOR_CONFIG__` (`webserver/index-inject`), and the Client
half reads that global before registering. Without a webserver the global is absent and the Client
half falls back to the code defaults.

```yaml
- insert:
    - id: preview-editor
      name: '@local/dsh-preview-editor'
      config:
        markdown: true          # once Edit is selected: true starts on the buffer, false on the rendered view
        editableAsDefault: false  # true makes Edit the DEFAULT viewer instead of the last menu entry
        maxBytes: 4194304       # cap on one read or save
        highlight: true         # syntax colours under the textarea
        highlightMaxBytes: 262144   # above this size the editor stays plain
        marks: true             # bands over the characters that cannot be seen
        marksMaxBytes: 262144   # above this size the editor stays unmarked
        lineNumbers: true       # the gutter beside the editor
        extensions: ['ts', 'py', 'env']   # replaces the built-in code suffix list
```

`extensions` entries may carry a leading dot. Omitting `extensions` keeps the built-in list
(text, code, config, and script suffixes).

**Which viewer opens first is a priority choice, not a suffix choice.** The registry ranks
`priority === 'builtin' ? 0 : 1` first, then the longest matched suffix, then registration order.
Every shipped viewer — Code, Text, Markdown, HTML, image, PDF — registers in the `builtin` band,
before this plugin. So both renderers here register in `builtin` too: the platform's own Code /
Text / Markdown viewers stay the **default**, and **Edit is the last of the matched viewers**.
One platform detail is worth knowing: the owner **unconditionally appends its plain-text
fallback** to every candidate list (`candidates = [...matched, plainText]`), and that fallback's
`extensions` is empty so it can never be outranked or reordered. The plain-text entry therefore
sits **after** Edit in the menu by design — this is the shipped viewer's own doing, not a ranking
mistake in this plugin. `_tools/verify-viewer-order.mjs` reproduces the exact algorithm.

Set `editableAsDefault: true` to restore the old behaviour (the `extension` band outranks every
`builtin` definition, making Edit the default). It is off by default because the shipped viewers
are the safer, faster read-only first look — and because a `.md` file should normally open rendered.

Markdown still gets its own registration: it claims `md`, `markdown`, `mdx`, `mdown` and `mkd`, so
Edit is offered for those files too. Once Edit is selected, `markdown: false` starts that body on
the rendered view with Edit one click away; `markdown: true` (default) starts on the buffer. The
knob is safe against a stale embedded config: it only chooses the body's initial toggle state, not
whether editing is reachable.

## Markdown

A `.md` file opens in the **shipped rendered preview** by default; **Edit** is the last entry of the
viewer menu. Once Edit is selected, the bar carries a **预览 / 编辑** toggle (`markdown: false`
starts that toggle on the rendered view instead). The rendered view is
this body's own: it feeds the current buffer to `MarkdownText` from the same platform module (the
component the shipped Markdown preview wraps), so the rendering is the shell's, not a second
implementation — including the code-block toolbar labels, which this body supplies from its own
dictionary. Ctrl+S keeps working while the rendered view is up, because the shortcut is caught one
level above the unmounted textarea.

Two consequences: the rendered view shows what you are about to save (not the file on disk), and you
do not need the viewer menu for it. The rest of the shipped preview's behaviour is reproduced here
rather than dropped: a leading frontmatter block is framed above the body, and relative image
destinations resolve against the document's own directory onto the app's authenticated
`api/file?path=` route — the same rules the shipped preview applies, re-derived from the read
result's absolute path instead of from the preview owner's resource plumbing.

## Install

`INSTALL.zh.md` is the full recipe. In short: the supported route is the Harness plugin manager,
which performs package installation and bundle selection itself —

```
plugin_manager  action: install_bundle  target: <absolute package directory>
```

— and the manual equivalent is to copy this directory to the target machine, add
`"@local/dsh-preview-editor": "link:<that directory>"` to the target profile's `dependencies`, and
append `"@local/dsh-preview-editor"` to its `dsh.profile.bundles` list **last**, so the row this
package inserts still lands after the bundles it extends. Replacing an installed package needs an app
restart; a page reload only picks up new browser code once the app serves it.

Display metadata lives in `locale/en.json` and `locale/zh.json` (`meta.title`, `meta.description`)
with `icon.svg` exported as `./icon`, so the plugin inventory and Settings show a real name and
artwork rather than falling back to defaults.

## Syntax colours

Highlighting reuses the shell's own highlighter instead of bundling one: the platform module
`@deepseek-ai/dsh-client-ui-primitives` publishes `useCodeHighlighter(language)` — the same hook the
shipped code preview builds its `CodeBlock` from — which returns a synchronous
`(code) => lines of {text, style}` tokenized in-process with the `css-variables` theme, so the colours
follow the active DSH theme and no language grammar is downloaded at runtime. `languageForPath(path)`
from the same module names the language, exactly as the shipped code body does it.

The editor is a **textarea over that painted layer**:

```
surface (position: relative, display: flex)
├─ gutter                    flex: none, overflow: hidden, pointer-events: none  ← numbers
└─ box (position: relative, flex: 1 1 auto)
   ├─ pre.shiki.css-variables  position: absolute, z-index 0, pointer-events: none  ← the colours
   └─ textarea                 position: relative,  z-index 1, color: transparent    ← caret + keys
```

The gutter is a **sibling** of the painted box, never a child of the textarea: it cannot grow the
scrollable area, cannot be selected or copied with the text, and cannot shift a glyph. Both children of
the box carry the same padding, font, font size, line height, tab size, wrapping and `box-sizing`,
which is what makes a caret in the textarea land on the glyph the layer painted; the layer is
positioned and lifted only in paint order, never in layout. Three consequences worth knowing:

- The layer renders the file's bytes verbatim, including the trailing newline; the tokenizer drops a
  trailing empty line, so `paintRows` appends that row itself — the gutter numbers the same rows, and
  both sides agree because the count comes from the text (`rowCount`) rather than from the tokenizer.
- The gutter's rows are **measured**, not computed: after every render the layer's
  `[data-preview-editor-line]` boxes are read and each row's top in content pixels is stored, so a
  wrapped line's number stays level with the first of its visual rows. When nothing can be measured —
  a shell without layout, or a row the browser reports no box for — a row falls back to
  `padding + index × line height`.
- Typing never waits for tokenizing: the layer draws `useDeferredValue(text)`, so it trails the
  textarea by a render. Above `highlightMaxBytes`, or when the path has no entry in the platform
  language table, the highlighter is not consulted at all and the bar shows **无高亮** — the marks, if
  they are on, still get their own plain layer.

A config change is read when the row activates; if a reload does not show it, restart the app once.

## Line numbers and invisible characters

Two reading aids the platform's own code preview has and a bare textarea does not. Both default to on;
both are switchable per row (`lineNumbers: false`, `marks: false`).

**Line numbers.** The gutter numbers every row the textarea shows, including the empty row after a
trailing newline, and follows the textarea's scrolling without being inside it: the rows are placed in
the textarea's own content coordinates and the whole strip is translated by its `scrollTop`. Nothing
about the numbers is copied into a save, and nothing about them is reachable by the caret.

**Marks.** The characters that are invisible on screen are marked *in place* — inside the character's
own box, never substituted for it, so no glyph ever moves and the caret keeps its position:

| Character | Mark |
|---|---|
| tab, no-break space, soft hyphen, ideographic space, narrow no-break space, medium mathematical space, line/paragraph separator | a band under the character, with an inset underline |
| zero-width space, ZWNJ, ZWJ, LRM, RLM, word joiner, byte order mark | an outline sliver, since the character has no width to fill |
| C0/C1 control characters other than tab and newline | the same band, as `u+XXXX control` |
| trailing spaces at the end of a line | the same band, as `u+0020 trailing space` |
| the end of every line | `↵` (LF) or `⏎` (CRLF), naming the file's own line ending |
| a final line with no line ending at all | `∅`, in a different colour, because a missing final newline is a real difference |

A mark's tooltip is language-neutral (`u+00A0 nbsp`): the character has no local name, and the name
stays readable in every locale. **Interior plain spaces are deliberately not marked** — a file full of
prose would drown in bands, and the mark would have to replace the character to be visible at all.

Like the syntax colours, the marks are bounded: above `marksMaxBytes` the bar shows **无标记** and the
editor stays exactly as it was.

## Limits

- **Mixed line endings are normalized** to the dominant ending on save.
- **Binary and non-UTF-8 files are refused** (`FS_NOT_TEXT`); the preview keeps its other viewers.
- **Highlighting is bounded**: it needs a language the platform table knows and a buffer under
  `highlightMaxBytes`; past that the editor is plain text, and the marks — if they are enabled — are
  the only thing painted. The marks are bounded the same way by `marksMaxBytes`.
- **Undo is the textarea's**: the browser's own stack, one entry per keystroke burst.
- **The gutter and the marks are painted, not modelled.** They add no indentation guides and no code
  folding, and a very long line's number stays with the line's first visual row rather than repeating
  on each of them. The alignment rests on the layer and the textarea sharing their metrics: the
  constants in `client.js` (`EDITOR_FONT_SIZE`, `EDITOR_LINE_HEIGHT`, `EDITOR_PAD_TOP`, `EDITOR_PAD_LEFT`)
  are the single place those metrics are defined, and the gutter measures the painted rows instead of
  assuming them.
- **The in-editor Markdown preview is this body's own.** It reproduces the shipped frontmatter
  framing and image resolution; the framed block shows verbatim source rather than the shipped
  preview's parsed field list.
- **The file watcher still owns reloads.** The editor reports its own version to the preview owner,
  so the built-in reload/auto-refresh path stays consistent.

## Layout

```
index.js            Host half: the editing route
client.js           Client half: renderer + body (a hand-written __ModuleLoader__ bundle)
cordis.patch.yml    Bundle patch inserting the `preview-editor` row
icon.svg            Inventory/Settings artwork, exported as `./icon`
verify.mjs          Dependency-free checks: host route round trip + client registration
verify-live.mjs     Asks a running app whether it serves this package's bundle
INSTALL.zh.md       Install, uninstall, and where the profile records this package (Chinese)
locale/en.json      Plugin display metadata
locale/zh.json      Plugin display metadata
```