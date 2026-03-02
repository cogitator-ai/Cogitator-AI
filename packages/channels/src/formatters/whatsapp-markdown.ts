const FENCE_PLACEHOLDER = '\x00FENCE';
const INLINE_CODE_PLACEHOLDER = '\x00CODE';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function markdownToWhatsApp(text: string): string {
  if (!text) return text;

  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `${FENCE_PLACEHOLDER}${fences.length - 1}`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}`;
  });

  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  result = result.replace(/~~(.+?)~~/g, '~$1~');

  result = result.replace(
    new RegExp(`${escapeRegExp(INLINE_CODE_PLACEHOLDER)}(\\d+)`, 'g'),
    (_, idx) => inlineCodes[Number(idx)] ?? ''
  );

  result = result.replace(
    new RegExp(`${escapeRegExp(FENCE_PLACEHOLDER)}(\\d+)`, 'g'),
    (_, idx) => fences[Number(idx)] ?? ''
  );

  return result;
}
