/** Fenced code blocks, closed or still streaming, and inline code spans: never math. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

function replaceDelimited(
  text: string,
  open: string,
  close: string,
  wrap: (body: string) => string
): string {
  let result = '';
  let index = 0;
  for (;;) {
    const start = text.indexOf(open, index);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    const body = text.slice(start + open.length, end).trim();
    result +=
      text.slice(index, start) + (body ? wrap(body) : text.slice(start, end + close.length));
    index = end + close.length;
  }
  return result + text.slice(index);
}

/**
 * Rewrites the LaTeX delimiters models write, `\(...\)` inline and `\[...\]`
 * for display, into the `$$` that remark-math reads, outside code. Single
 * dollars are left alone, so prices stay text.
 */
export function normalizeMath(markdown: string): string {
  return markdown
    .split(CODE)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const display = replaceDelimited(part, '\\[', '\\]', (body) => `\n\n$$\n${body}\n$$\n\n`);
      return replaceDelimited(display, '\\(', '\\)', (body) => `$$${body}$$`);
    })
    .join('');
}
