import type { ChannelType } from '@cogitator-ai/types';
import { markdownToWhatsApp } from './whatsapp-markdown';
import { protectCode } from './code-protect';

const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  whatsapp: 65536,
  webchat: Infinity,
};

const DEFAULT_LIMIT = 4096;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function getPlatformLimit(channelType: ChannelType): number {
  return PLATFORM_LIMITS[channelType] ?? DEFAULT_LIMIT;
}

export function adaptMarkdown(text: string, channelType: ChannelType): string {
  switch (channelType) {
    case 'telegram':
      return toTelegramMarkdown(text);
    case 'slack':
      return toSlackMarkdown(text);
    case 'whatsapp':
      return markdownToWhatsApp(text);
    default:
      return text;
  }
}

function headingToBold(_: string, title: string): string {
  return `*${title.replace(/\*\*/g, '')}*`;
}

function toTelegramMarkdown(text: string): string {
  return protectCode(text, (prose) =>
    prose
      .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, headingToBold)
      .replace(/^(\s*)[*+]\s+/gm, '$1• ')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '_$1_')
      .replace(/~~(.+?)~~/g, '$1')
  );
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toSlackMarkdown(text: string): string {
  return protectCode(escapeSlack(text), (prose) =>
    prose
      .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, headingToBold)
      .replace(/^(\s*)[*+]\s+/gm, '$1• ')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      .replace(/~~(.+?)~~/g, '~$1~')
      .replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, '<$2|$1>')
  );
}

interface ChunkSplit {
  end: number;
  resume: number;
}

function findSplit(text: string, maxLength: number): ChunkSplit {
  const paragraph = text.lastIndexOf('\n\n', maxLength);
  if (paragraph > 0) return { end: paragraph, resume: paragraph + 2 };

  const line = text.lastIndexOf('\n', maxLength);
  if (line > 0) return { end: line, resume: line + 1 };

  const space = text.lastIndexOf(' ', maxLength);
  if (space > 0) return { end: space, resume: space + 1 };

  return { end: maxLength, resume: maxLength };
}

function openFenceAtEnd(text: string): string | null {
  let open: { line: string; marker: string } | null = null;
  for (const line of text.split('\n')) {
    const match = FENCE_LINE_RE.exec(line);
    if (!match) continue;
    const marker = match[1];
    if (!open) {
      open = { line, marker };
    } else if (marker.startsWith(open.marker[0]) && marker.length >= open.marker.length) {
      open = null;
    }
  }
  return open?.line ?? null;
}

function closingFenceFor(openLine: string): string {
  return FENCE_LINE_RE.exec(openLine)?.[1] ?? '```';
}

export function chunkMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const maxLength = Math.max(1, Math.floor(limit));

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let split = findSplit(remaining, maxLength);
    let chunk = remaining.slice(0, split.end);
    const fence = openFenceAtEnd(chunk);

    if (fence) {
      const closing = closingFenceFor(fence);
      const reserve = closing.length + 1;
      const room = maxLength - reserve;
      if (room > fence.length + 1) {
        split = findSplit(remaining, room);
        if (split.resume <= fence.length + 1) split = { end: room, resume: room };
        chunk = remaining.slice(0, split.end);
        const stillOpen = openFenceAtEnd(chunk);
        if (stillOpen && split.resume > stillOpen.length + 1) {
          chunks.push(`${chunk}\n${closingFenceFor(stillOpen)}`);
          remaining = `${stillOpen}\n${remaining.slice(split.resume)}`;
          continue;
        }
      }
    }

    chunks.push(chunk);
    remaining = remaining.slice(split.resume);
  }

  return chunks.filter((c) => c.length > 0);
}
