/** Escapes text for HTML content and attribute values */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Text that may be long or span lines: as it is when short, folded in `<details>` otherwise */
export function foldable(value: string, max: number = 120): string {
  const line = value.replace(/\s+/g, ' ').trim();
  if (line.length <= max && !value.includes('\n')) return escapeHtml(value);
  const summary = [...line]
    .slice(0, max - 3)
    .join('')
    .trimEnd();
  return `<details><summary>${escapeHtml(summary)}...</summary><pre>${escapeHtml(value)}</pre></details>`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f5f6f8;
  --text: #1c1f24;
  --muted: #5b6370;
  --border: #d9dde3;
  --pass: #1a7f37;
  --fail: #cf222e;
  --warn: #9a6700;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --surface: #181b21;
    --text: #e6e8eb;
    --muted: #9aa3ae;
    --border: #2c313a;
    --pass: #3fb950;
    --fail: #f85149;
    --warn: #d29922;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 16px 48px;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 8px; }
.sub { color: var(--muted); margin: 0 0 16px; }
.tiles { display: flex; flex-wrap: wrap; gap: 8px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; min-width: 110px; }
.tile b { display: block; font-size: 18px; }
.tile span { color: var(--muted); font-size: 12px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pass { color: var(--pass); font-weight: 600; }
.fail { color: var(--fail); font-weight: 600; }
.warn { color: var(--warn); }
.muted { color: var(--muted); }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
details summary { cursor: pointer; }
ul { padding-left: 20px; }
`;

/**
 * A self-contained HTML page: inline CSS, no scripts and no external assets. `style` adds rules
 * of the page's own after the shared ones
 */
export function htmlDocument(title: string, body: string, style: string = ''): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}${style}</style>`,
    '</head>',
    '<body>',
    '<main>',
    body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A table, its cells already HTML; `numeric` marks the columns aligned right */
export function htmlTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  numeric: ReadonlySet<number> = new Set()
): string {
  const head = headers
    .map((h, i) => `<th${numeric.has(i) ? ' class="n"' : ''}>${escapeHtml(h)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((c, i) => `<td${numeric.has(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`
    )
    .join('\n');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

/** A row of figures, each value already HTML */
export function htmlTiles(tiles: ReadonlyArray<readonly [label: string, value: string]>): string {
  return `<div class="tiles">${tiles
    .map(
      ([label, value]) => `<div class="tile"><b>${value}</b><span>${escapeHtml(label)}</span></div>`
    )
    .join('')}</div>`;
}
