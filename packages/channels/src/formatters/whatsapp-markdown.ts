import { protectCode } from './code-protect';

export function markdownToWhatsApp(text: string): string {
  if (!text) return text;

  return protectCode(text, (prose) =>
    prose
      .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, (_, title: string) => `*${title.replace(/\*\*/g, '')}*`)
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      .replace(/~~(.+?)~~/g, '~$1~')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
  );
}
