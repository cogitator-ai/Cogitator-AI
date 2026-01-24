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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseInline(text: string, sanitize: boolean): string {
  let result = sanitize ? escapeHtml(text) : text;

  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>');

  result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return result;
}

function parseMarkdown(md: string, sanitize: boolean, gfm: boolean): string {
  const lines = md.split('\n');
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
        const content = sanitize
          ? escapeHtml(codeBlockContent.join('\n'))
          : codeBlockContent.join('\n');
        html.push(
          `<pre><code${codeBlockLang ? ` class="language-${codeBlockLang}"` : ''}>${content}</code></pre>`
        );
        codeBlockContent = [];
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushBlockquote();
        flushList();
        codeBlockLang = line.slice(3).trim();
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

    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      flushParagraph();
      flushBlockquote();
      flushList();
      const level = headerMatch[1].length;
      const content = parseInline(headerMatch[2], sanitize);
      html.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      flushBlockquote();
      flushList();
      html.push('<hr>');
      continue;
    }

    const blockquoteMatch = line.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      flushParagraph();
      flushList();
      inBlockquote = true;
      blockquoteContent.push(blockquoteMatch[1]);
      continue;
    }

    const ulMatch = line.match(/^[-*+]\s+(.+)$/);
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

    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      flushBlockquote();
      if (!inList || listType !== 'ol') {
        flushList();
        html.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      html.push(`<li>${parseInline(olMatch[1], sanitize)}</li>`);
      continue;
    }

    if (gfm && line.includes('|')) {
      flushParagraph();
      flushBlockquote();
      flushList();

      const tableLines: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].includes('|')) {
        i++;
        tableLines.push(lines[i]);
      }

      if (tableLines.length >= 2) {
        const headerCells = tableLines[0]
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c);
        const rows = tableLines.slice(2);

        html.push('<table>');
        html.push('<thead><tr>');
        for (const cell of headerCells) {
          html.push(`<th>${parseInline(cell, sanitize)}</th>`);
        }
        html.push('</tr></thead>');

        if (rows.length > 0) {
          html.push('<tbody>');
          for (const row of rows) {
            const cells = row
              .split('|')
              .map((c) => c.trim())
              .filter((c) => c);
            html.push('<tr>');
            for (const cell of cells) {
              html.push(`<td>${parseInline(cell, sanitize)}</td>`);
            }
            html.push('</tr>');
          }
          html.push('</tbody>');
        }
        html.push('</table>');
      }
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
    const content = sanitize
      ? escapeHtml(codeBlockContent.join('\n'))
      : codeBlockContent.join('\n');
    html.push(`<pre><code>${content}</code></pre>`);
  }

  return html.join('\n');
}

export function markdown(): number {
  try {
    const inputStr = Host.inputString();
    const input: MarkdownInput = JSON.parse(inputStr);

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
