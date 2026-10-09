const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm;

function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt: string, url: string) =>
      alt ? `${alt}: ${url}` : url
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
      label === url || `${label}` === url.replace(/^https?:\/\//, '') ? url : `${label} (${url})`
    )
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
}

/**
 * Markdown as plain text, for feeds that show text as written: Bluesky and
 * Threads. Headings, emphasis and code marks go, code keeps its content,
 * links show their URL so the feed can link it, list items get a bullet.
 */
export function markdownToPlainText(markdown: string): string {
  const code: string[] = [];
  const keep = (text: string) => `\uE000${code.push(text) - 1}\uE000`;
  let text = markdown.replace(FENCE, (_, _fence: string, body: string) => keep(body));
  text = text.replace(/`([^`\n]+)`/g, (_, body: string) => keep(body));
  text = text
    .split('\n')
    .map((line) => {
      if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
      const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) return inline(heading[1]);
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
      return inline(line.replace(/^ {0,3}>\s?/, ''));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.replace(/\uE000(\d+)\uE000/g, (_, index: string) => code[Number(index)]).trim();
}
