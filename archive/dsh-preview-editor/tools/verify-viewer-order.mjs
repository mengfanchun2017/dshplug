/**
 * Reproduce the shipped viewer-menu order EXACTLY, including the plain-text
 * fallback that the platform appends unconditionally.
 *
 * From dsh-client-ui-sidebar-documentpreview/lib/client.js:
 *   matchingDocumentPreviews(): rank = priority === 'builtin' ? 0 : 1
 *     sort: right.rank - left.rank || right.length - left.length || left.order - right.order
 *   textBodyDefinition(): id = PLAIN_BODY_ID, extensions: []  <- never enters matched
 *   candidates = [...matched, plainFallback]                 <- plain text is ALWAYS last
 */
const PLAIN = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text';

function order(definitions, name) {
  const length = (exts) => Math.max(0, ...exts.map((e) => (name.endsWith('.' + e) ? e.length : 0)));
  const matched = definitions
    .map((d, i) => ({ d, i, rank: d.priority === 'builtin' ? 0 : 1, len: length(d.extensions) }))
    .filter((c) => c.len > 0)
    .sort((a, b) => b.rank - a.rank || b.len - a.len || a.i - b.i)
    .map((c) => c.d.id);
  // The platform appends the plain-text fallback to EVERY candidate list.
  return [...matched, PLAIN];
}

const shipped = [
  { id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code', priority: 'builtin',
    extensions: ['ts', 'py', 'json', 'yml', 'txt', 'md'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown', priority: 'builtin',
    extensions: ['md', 'markdown'] }
];

const defs = (band, mdBand) => [
  ...shipped,
  { id: '@local/dsh-preview-editor/text', priority: band,
    extensions: ['ts', 'py', 'json', 'yml', 'txt'] },
  { id: '@local/dsh-preview-editor/markdown', priority: mdBand,
    extensions: ['md', 'markdown'] }
];

const short = (id) => id
  .replace('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/', '')
  .replace('@local/dsh-preview-editor/', 'EDIT/');

for (const [label, band, mdBand] of [
  ['1.0.4 default (builtin)', 'builtin', 'builtin'],
  ['editableAsDefault: true', 'extension', 'extension']
]) {
  for (const file of ['a.ts', 'a.md', 'a.yml', 'a.txt']) {
    const list = order(defs(band, mdBand), file);
    const editAt = list.findIndex((id) => id.startsWith('@local/'));
    const plainAt = list.indexOf(PLAIN);
    console.log(`${label.padEnd(26)} ${file.padEnd(7)} [${list.map(short).join(' > ')}]  Edit@${editAt} Plain@${plainAt}`);
  }
}
