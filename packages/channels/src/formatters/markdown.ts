import type { ChannelType } from '@cogitator-ai/types';

const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  whatsapp: 65536,
  webchat: Infinity,
};

export function getPlatformLimit(channelType: ChannelType): number {
  return PLATFORM_LIMITS[channelType] ?? 4096;
}

export function adaptMarkdown(text: string, channelType: ChannelType): string {
  switch (channelType) {
    case 'telegram':
      return toTelegramMarkdown(text);
    case 'slack':
      return toSlackMarkdown(text);
    default:
      return text;
  }
}

function toTelegramMarkdown(text: string): string {
  return text
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*');
}

function toSlackMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*');
}

export function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt <= 0) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
