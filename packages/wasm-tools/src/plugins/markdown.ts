interface MarkdownInput {
  markdown: string;
  options?: {
    sanitize?: boolean;
    gfm?: boolean;
  };
}

interface MarkdownOutput {
  html: string;
  error?: string;
}

const PLACEHOLDER_MARK = '\uE000';
const PLACEHOLDER = /\uE000(\d+)\uE000/g;
const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel', 'ftp'];
const URL_PATTERN = String.raw`(<[^<>\n]*>|[^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*)`;
const TITLE_PATTERN = String.raw`(?:\s+"([^"]*)")?`;
const IMAGE_REGEX = new RegExp(
  String.raw`!\[([^\]]*)\]\(\s*` + URL_PATTERN + TITLE_PATTERN + String.raw`\s*\)`,
  'g'
);
const LINK_REGEX = new RegExp(
  String.raw`\[([^\]]+)\]\(\s*` + URL_PATTERN + TITLE_PATTERN + String.raw`\s*\)`,
  'g'
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanUrl(raw: string): string {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
}

function safeUrl(url: string, sanitize: boolean): string {
  if (!sanitize) return url;
  const normalized = Array.from(url)
    .filter((ch) => ch.charCodeAt(0) > 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);
  if (scheme && !SAFE_SCHEMES.includes(scheme[1])) return '#';
  return url;
}

function applyEmphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/\*(?=[^\s*])([^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function parseInline(text: string, sanitize: boolean): string {
  const stash: string[] = [];
  const hold = (html: string): string =>
    `${PLACEHOLDER_MARK}${stash.push(html) - 1}${PLACEHOLDER_MARK}`;

  let result = text.split(PLACEHOLDER_MARK).join('');

  result = result.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => {
    const content = /^ [\s\S]* $/.test(code) && code.trim() ? code.slice(1, -1) : code;
    return hold(`<code>${escapeHtml(content)}</code>`);
  });

  result = result.replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, (_m, ch: string) =>
    hold(escapeHtml(ch))
  );

  result = result.replace(IMAGE_REGEX, (_m, alt: string, rawUrl: string, title?: string) => {
    const src = escapeHtml(safeUrl(cleanUrl(rawUrl), sanitize));
    const titleAttr = title !== undefined ? ` title="${escapeHtml(title)}"` : '';
    return hold(`<img src="${src}" alt="${escapeHtml(alt)}"${titleAttr}>`);
  });

  result = result.replace(LINK_REGEX, (_m, label: string, rawUrl: string, title?: string) => {
    const href = escapeHtml(safeUrl(cleanUrl(rawUrl), sanitize));
    const titleAttr = title !== undefined ? ` title="${escapeHtml(title)}"` : '';
    return `${hold(`<a href="${href}"${titleAttr}>`)}${label}${hold('</a>')}`;
  });

  result = result.replace(/<((?:https?|mailto):[^\s<>]+)>/gi, (_m, url: string) => {
    const href = escapeHtml(safeUrl(url, sanitize));
    return hold(`<a href="${href}">${escapeHtml(url)}</a>`);
  });

  if (sanitize) {
    result = escapeHtml(result);
  }

  result = applyEmphasis(result);

  return result.replace(PLACEHOLDER, (_m, index: string) => stash[Number(index)] ?? '');
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (row[i] === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += row[i];
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(line: string): Array<'left' | 'center' | 'right' | null> | null {
  if (!line.includes('-')) return null;
  const cells = splitTableRow(line);
  const alignments: Array<'left' | 'center' | 'right' | null> = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    alignments.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return alignments;
}

function alignAttr(alignment: 'left' | 'center' | 'right' | null | undefined): string {
  return alignment ? ` style="text-align:${alignment}"` : '';
}

function renderCodeBlock(content: string[], lang: string): string {
  const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre><code${langAttr}>${escapeHtml(content.join('\n'))}</code></pre>`;
}

function parseMarkdown(md: string, sanitize: boolean, gfm: boolean): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';
  let inBlockquote = false;
  let blockquoteContent: string[] = [];
  let inParagraph = false;
  let paragraphContent: string[] = [];

  const flushParagraph = () => {
    if (inParagraph && paragraphContent.length > 0) {
      html.push(`<p>${parseInline(paragraphContent.join(' '), sanitize)}</p>`);
      paragraphContent = [];
      inParagraph = false;
    }
  };

  const flushBlockquote = () => {
    if (inBlockquote && blockquoteContent.length > 0) {
      html.push(
        `<blockquote><p>${parseInline(blockquoteContent.join(' '), sanitize)}</p></blockquote>`
      );
      blockquoteContent = [];
      inBlockquote = false;
    }
  };

  const flushList = () => {
    if (inList) {
      html.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        html.push(renderCodeBlock(codeBlockContent, codeBlockLang));
        codeBlockContent = [];
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushBlockquote();
        flushList();
        codeBlockLang = line.slice(3).trim().split(/\s+/)[0] ?? '';
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushBlockquote();
      flushList();
      continue;
    }

    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headerMatch) {
      flushParagraph();
      flushBlockquote();
      flushList();
      const level = headerMatch[1].length;
      const content = parseInline(headerMatch[2].replace(/\s+#+\s*$/, '').trim(), sanitize);
      html.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    if (/^([-*_])(\s*\1){2,}$/.test(line.trim())) {
      flushParagraph();
      flushBlockquote();
      flushList();
      html.push('<hr>');
      continue;
    }

    const blockquoteMatch = /^>\s?(.*)$/.exec(line);
    if (blockquoteMatch) {
      flushParagraph();
      flushList();
      inBlockquote = true;
      blockquoteContent.push(blockquoteMatch[1]);
      continue;
    }

    const ulMatch = /^[-*+]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushParagraph();
      flushBlockquote();
      if (!inList || listType !== 'ul') {
        flushList();
        html.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      html.push(`<li>${parseInline(ulMatch[1], sanitize)}</li>`);
      continue;
    }

    const olMatch = /^(\d{1,9})[.)]\s+(.+)$/.exec(line);
    if (olMatch) {
      flushParagraph();
      flushBlockquote();
      if (!inList || listType !== 'ol') {
        flushList();
        const start = parseInt(olMatch[1], 10);
        html.push(start === 1 ? '<ol>' : `<ol start="${start}">`);
        inList = true;
        listType = 'ol';
      }
      html.push(`<li>${parseInline(olMatch[2], sanitize)}</li>`);
      continue;
    }

    const alignments =
      gfm && line.includes('|') && i + 1 < lines.length ? parseTableAlignments(lines[i + 1]) : null;
    if (alignments) {
      flushParagraph();
      flushBlockquote();
      flushList();

      const headerCells = splitTableRow(line);
      const columns = headerCells.length;
      i++;

      html.push('<table>');
      html.push('<thead><tr>');
      headerCells.forEach((cell, index) => {
        html.push(`<th${alignAttr(alignments[index])}>${parseInline(cell, sanitize)}</th>`);
      });
      html.push('</tr></thead>');

      const bodyRows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim() !== '') {
        i++;
        bodyRows.push(splitTableRow(lines[i]));
      }

      if (bodyRows.length > 0) {
        html.push('<tbody>');
        for (const row of bodyRows) {
          html.push('<tr>');
          for (let c = 0; c < columns; c++) {
            html.push(`<td${alignAttr(alignments[c])}>${parseInline(row[c] ?? '', sanitize)}</td>`);
          }
          html.push('</tr>');
        }
        html.push('</tbody>');
      }
      html.push('</table>');
      continue;
    }

    flushBlockquote();
    flushList();
    inParagraph = true;
    paragraphContent.push(line.trim());
  }

  flushParagraph();
  flushBlockquote();
  flushList();

  if (inCodeBlock) {
    html.push(renderCodeBlock(codeBlockContent, codeBlockLang));
  }

  return html.join('\n');
}

export function markdown(): number {
  try {
    const inputStr = Host.inputString();
    const input: MarkdownInput = JSON.parse(inputStr);
    if (typeof input.markdown !== 'string') {
      throw new Error('markdown must be a string');
    }

    const sanitize = input.options?.sanitize ?? true;
    const gfm = input.options?.gfm ?? true;

    const htmlResult = parseMarkdown(input.markdown, sanitize, gfm);

    const output: MarkdownOutput = {
      html: htmlResult,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: MarkdownOutput = {
      html: '',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
