const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  bull: '\u2022',
  middot: '\u00B7',
  euro: '\u20AC',
  zwnj: '',
  zwj: '',
  shy: '',
};

/** Text with HTML entities (named, decimal and hex) decoded, unknown names staying as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SKIPPED = new Set(['script', 'style', 'head', 'title', 'template', 'noscript']);
const PARAGRAPHS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'pre',
  'dl',
  'figure',
]);
const LINES = new Set([
  'div',
  'tr',
  'li',
  'section',
  'article',
  'header',
  'footer',
  'address',
  'dt',
  'dd',
  'caption',
  'center',
]);

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    attributes
  );
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlEntities(value);
}

interface Line {
  depth: number;
  text: string;
}

/** `text` without the trailing characters of `chars`, in one pass from the end. */
function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

type HtmlToken = { text: string } | { closing: boolean; name: string; attributes: string };

const TAG_NAME = /\/?([a-zA-Z][\w:-]*)/y;

/**
 * The tokens of HTML, in one linear pass: text, and tags with their attributes. Comments,
 * CDATA, doctypes and processing instructions are left out. A tag that is never closed makes
 * the rest of the input text, and a comment that is never closed drops it, so malformed input
 * cannot make the scan go over the rest again for every `<`.
 */
function* htmlTokens(html: string): Generator<HtmlToken> {
  let i = 0;
  const skipTo = (marker: string, from: number) => {
    const end = html.indexOf(marker, from);
    return end === -1 ? html.length : end + marker.length;
  };
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) {
      yield { text: html.slice(i) };
      return;
    }
    if (open > i) yield { text: html.slice(i, open) };
    if (html.startsWith('<!--', open)) {
      i = skipTo('-->', open + 4);
      continue;
    }
    if (html.startsWith('<![CDATA[', open)) {
      i = skipTo(']]>', open + 9);
      continue;
    }
    if (html[open + 1] === '!' || html[open + 1] === '?') {
      i = skipTo('>', open + 2);
      continue;
    }
    TAG_NAME.lastIndex = open + 1;
    const name = TAG_NAME.exec(html);
    if (!name) {
      yield { text: '<' };
      i = open + 1;
      continue;
    }
    const attributesStart = TAG_NAME.lastIndex;
    let end = attributesStart;
    let quote = '';
    let previous = '';
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if ((char === '"' || char === "'") && previous === '=') quote = char;
      else if (char === '>') break;
      if (!/\s/.test(char)) previous = char;
    }
    if (end >= html.length) {
      yield { text: html.slice(open) };
      return;
    }
    yield {
      closing: name[0].startsWith('/'),
      name: name[1],
      attributes: html.slice(attributesStart, end),
    };
    i = end + 1;
  }
}

/**
 * The text of an HTML email: paragraphs and line breaks kept, links written as `text (url)`,
 * list items with a dash, quoted blocks (`<blockquote>`) as `>` lines, scripts, styles and the
 * head dropped and entities decoded.
 */
export function htmlToText(html: string): string {
  const lines: Line[] = [];
  let line = '';
  let depth = 0;
  let lineDepth = 0;
  let skipping = 0;
  let pre = 0;
  const lists: { ordered: boolean; next: number }[] = [];
  const links: { href?: string; start: number }[] = [];

  const flush = () => {
    lines.push({ depth: lineDepth, text: trimEndOf(line, ' \t') });
    line = '';
    lineDepth = depth;
  };
  const endLine = () => {
    if (line.trim()) flush();
    else {
      line = '';
      lineDepth = depth;
    }
  };
  const endParagraph = () => {
    endLine();
    const last = lines[lines.length - 1];
    if (last && last.text !== '') lines.push({ depth: last.depth, text: '' });
  };
  const write = (text: string) => {
    if (!line) lineDepth = depth;
    line += text;
  };

  for (const token of htmlTokens(html)) {
    if ('text' in token) {
      if (skipping > 0) continue;
      const decoded = decodeHtmlEntities(token.text);
      if (pre > 0) {
        const parts = decoded.split('\n');
        parts.forEach((part, index) => {
          if (index > 0) flush();
          write(part);
        });
      } else {
        const collapsed = decoded.replace(/\s+/g, ' ');
        write(line === '' || line.endsWith(' ') ? collapsed.replace(/^ /, '') : collapsed);
      }
      continue;
    }
    const { closing, attributes } = token;
    const name = token.name.toLowerCase();
    if (SKIPPED.has(name)) {
      if (closing) skipping = Math.max(0, skipping - 1);
      else if (!attributes.trimEnd().endsWith('/')) skipping++;
      continue;
    }
    if (skipping > 0) continue;
    if (closing) {
      switch (name) {
        case 'blockquote':
          endParagraph();
          depth = Math.max(0, depth - 1);
          lineDepth = depth;
          break;
        case 'pre':
          pre = Math.max(0, pre - 1);
          endParagraph();
          break;
        case 'ul':
        case 'ol':
          lists.pop();
          endParagraph();
          break;
        case 'a': {
          const link = links.pop();
          const label = link ? line.slice(link.start).trim() : '';
          if (
            link?.href &&
            /^https?:\/\//i.test(link.href) &&
            label !== link.href &&
            label !== link.href.replace(/^https?:\/\//i, '').replace(/\/$/, '')
          ) {
            write(label ? ` (${link.href})` : link.href);
          }
          break;
        }
        case 'td':
        case 'th':
          write('\t');
          break;
        default:
          if (PARAGRAPHS.has(name)) endParagraph();
          else if (LINES.has(name)) endLine();
      }
      continue;
    }
    switch (name) {
      case 'br':
        flush();
        break;
      case 'hr':
        endLine();
        write('---');
        endLine();
        break;
      case 'img': {
        const alt = attribute(attributes, 'alt');
        if (alt) write(alt);
        break;
      }
      case 'blockquote':
        endParagraph();
        depth++;
        lineDepth = depth;
        break;
      case 'pre':
        endParagraph();
        pre++;
        break;
      case 'ul':
      case 'ol':
        endLine();
        lists.push({ ordered: name === 'ol', next: Number(attribute(attributes, 'start')) || 1 });
        break;
      case 'li': {
        endLine();
        const list = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        write(list?.ordered ? `${indent}${list.next++}. ` : `${indent}- `);
        break;
      }
      case 'a':
        links.push({ href: attribute(attributes, 'href'), start: line.length });
        break;
      default:
        if (PARAGRAPHS.has(name)) endParagraph();
        else if (LINES.has(name)) endLine();
    }
  }
  endLine();

  const rendered = lines.map(({ depth: level, text }) => {
    const cleaned = trimEndOf(text, '\t').replace(/\t/g, ' | ');
    return level > 0 ? `${'> '.repeat(level)}${cleaned}`.trimEnd() : cleaned;
  });
  while (rendered.length > 0 && trimEndOf(rendered[rendered.length - 1], '> ') === '') {
    rendered.pop();
  }
  return rendered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CODE_STYLE =
  'font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f4f4f5; border-radius: 4px';

function safeUrl(url: string): string | undefined {
  const decoded = decodeHtmlEntities(url).trim();
  return /^(https?:|mailto:)/i.test(decoded) ? escapeHtml(decoded) : undefined;
}

/** Inline Markdown (code spans, emphasis, links) as HTML, the text escaped. */
function inlineHtml(input: string): string {
  const code: string[] = [];
  const keep = (html: string) => `\uE000${code.push(html) - 1}\uE000`;
  const text = input.replace(/\uE000/g, '\uFFFD');
  let html = text.replace(/(`+)([\s\S]{0,4000}?[^`])\1(?!`)/g, (_, _ticks: string, body: string) =>
    keep(`<code style="${CODE_STYLE}; padding: 0 3px">${escapeHtml(body.trim())}</code>`)
  );
  html = escapeHtml(html)
    .replace(
      /!\[([^\]\n]{0,1000})\]\(([^)\s]{1,2048})(?:\s+&quot;[^)\n]{0,1000}&quot;)?\)/g,
      (whole, alt: string, url: string) => {
        const href = safeUrl(url);
        return href ? keep(`<a href="${href}">${alt || href}</a>`) : whole;
      }
    )
    .replace(
      /\[([^\]\n]{1,1000})\]\(([^)\s]{1,2048})(?:\s+&quot;[^)\n]{0,1000}&quot;)?\)/g,
      (whole, label: string, url: string) => {
        const href = safeUrl(url);
        return href ? keep(`<a href="${href}">${label}</a>`) : whole;
      }
    )
    .replace(
      /&lt;((?:https?:\/\/|mailto:)[^\s&]{1,2048}(?:&amp;[^\s&]{1,2048}){0,64})&gt;/gi,
      (whole, url: string) => {
        const href = safeUrl(url);
        return href ? keep(`<a href="${href}">${url}</a>`) : whole;
      }
    )
    .replace(/(\*\*|__)(?=\S)([^\n]{0,2000}?\S)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '<em>$1</em>')
    .replace(/~~(?=\S)([^\n]{0,2000}?\S)~~/g, '<del>$1</del>')
    .replace(/\n/g, '<br>\n');
  for (let round = 0; round < 3 && html.includes('\uE000'); round++) {
    html = html.replace(/\uE000(\d+)\uE000/g, (_, index: string) => code[Number(index)]);
  }
  return html;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
  );
}

function renderList(lines: string[]): string {
  const first = LIST_ITEM.exec(lines[0]);
  const indent = first?.[1].length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? '');
  const items: string[][] = [];
  for (const line of lines) {
    const item = LIST_ITEM.exec(line);
    if (item && item[1].length <= indent) items.push([item[3]]);
    else if (items.length > 0) items[items.length - 1].push(line.replace(/^\s{1,4}/, ''));
  }
  const start = ordered ? Number(/\d+/.exec(first?.[2] ?? '1')?.[0] ?? 1) : 1;
  const tag = ordered ? 'ol' : 'ul';
  const body = items
    .map((item) => {
      const nested = item.findIndex((line, index) => index > 0 && LIST_ITEM.test(line));
      if (nested === -1 && !item.some((line) => !line.trim())) {
        return `<li>${inlineHtml(item.join('\n').trim())}</li>`;
      }
      const head = nested === -1 ? item : item.slice(0, nested);
      const rest = nested === -1 ? [] : item.slice(nested);
      return `<li>${inlineHtml(head.join('\n').trim())}${rest.length ? renderBlocks(rest) : ''}</li>`;
    })
    .join('');
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${body}</${tag}>`;
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (closing?.[1].startsWith(marker[0]) && closing[1].length >= marker.length) break;
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        `<pre style="${CODE_STYLE}; padding: 8px 12px; overflow-x: auto"><code>${escapeHtml(body.join('\n'))}</code></pre>`
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const match = QUOTE.exec(lines[i]);
        quoted.push(match ? match[1] : lines[i]);
        i++;
      }
      out.push(
        `<blockquote style="margin: 0 0 0 8px; padding-left: 12px; border-left: 3px solid #d4d4d8; color: #52525b">${renderBlocks(quoted)}</blockquote>`
      );
      continue;
    }
    const listStart = LIST_ITEM.exec(line);
    if (listStart) {
      const indent = listStart[1].length;
      const ordered = /\d/.test(listStart[2]);
      const sameList = (candidate: string) => {
        const item = LIST_ITEM.exec(candidate);
        if (!item) return false;
        return item[1].length > indent || /\d/.test(item[2]) === ordered;
      };
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        if (LIST_ITEM.test(current) && !sameList(current)) break;
        if (!current.trim()) {
          const next = lines[i + 1];
          if (next !== undefined && (sameList(next) || /^\s{2,}\S/.test(next))) {
            items.push(current);
            i++;
            continue;
          }
          break;
        }
        if (!LIST_ITEM.test(current) && !/^\s/.test(current) && items.length > 0) {
          const previous = items[items.length - 1];
          if (!previous.trim() || startsBlock(current, lines[i + 1])) break;
        }
        items.push(current);
        i++;
      }
      out.push(renderList(items));
      continue;
    }
    const next = lines[i + 1];
    if (
      line.includes('|') &&
      next !== undefined &&
      TABLE_SEPARATOR.test(next) &&
      next.includes('-')
    ) {
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      const cell = (tag: 'th' | 'td', text: string) =>
        `<${tag} style="border: 1px solid #d4d4d8; padding: 4px 8px; text-align: left">${inlineHtml(text)}</${tag}>`;
      out.push(
        `<table style="border-collapse: collapse"><thead><tr>${header.map((text) => cell('th', text)).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((text) => cell('td', text)).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      paragraph.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineHtml(paragraph.join('\n').trim())}</p>`);
  }
  return out.join('\n');
}

/**
 * Markdown as the HTML body of an email: headings, paragraphs, lists, quotes, code blocks,
 * tables, emphasis and links (only `http`, `https` and `mailto`), with inline styles, since
 * many mail clients drop style sheets. Raw HTML in the Markdown is escaped, not rendered.
 */
export function markdownToHtml(markdown: string): string {
  const body = renderBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'));
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #18181b">\n${body}\n</div>`;
}
