const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;
const MARK = '';
const PLACEHOLDER_RE = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

export function protectCode(text: string, transform: (prose: string) => string): string {
  const stash: string[] = [];
  const masked = text.replace(CODE_RE, (match) => {
    stash.push(match);
    return `${MARK}${stash.length - 1}${MARK}`;
  });
  return transform(masked).replace(PLACEHOLDER_RE, (_, idx: string) => stash[Number(idx)] ?? '');
}
