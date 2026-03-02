import type { ChannelMessage, EnvelopeConfig } from '@cogitator-ai/types';

export function formatElapsed(ms: number): string {
  if (ms < 0) return '+0s';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `+${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) {
    return remainSec > 0 ? `+${minutes}m${remainSec}s` : `+${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) {
    return remainMin > 0 ? `+${hours}h${remainMin}m` : `+${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainHrs = hours % 24;
  return remainHrs > 0 ? `+${days}d${remainHrs}h` : `+${days}d`;
}

function sanitize(str: string): string {
  return str.replace(/[[\]\n\r]/g, ' ').trim();
}

function formatTime(timestamp: number, timezone?: string): string {
  const tz = timezone === 'local' ? undefined : (timezone ?? 'utc');
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (tz && tz !== 'utc') {
    opts.timeZone = tz;
  } else if (tz === 'utc') {
    opts.timeZone = 'UTC';
  }
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(timestamp));
}

export function formatEnvelope(
  msg: ChannelMessage,
  config: EnvelopeConfig,
  previousTimestamp?: number
): string {
  const parts: string[] = [];

  const includeTimestamp = config.includeTimestamp ?? true;
  if (includeTimestamp) {
    parts.push(formatTime(Date.now(), config.timezone));
  }

  if (config.includeChannel !== false) {
    parts.push(msg.channelType);
  }

  if (config.includeSender !== false && msg.userName) {
    parts.push(sanitize(msg.userName));
  }

  if (config.includeChatType) {
    parts.push(msg.groupId ? 'group' : 'DM');
  }

  const includeElapsed = config.includeElapsed ?? true;
  if (includeElapsed && previousTimestamp !== undefined) {
    const elapsed = Date.now() - previousTimestamp;
    parts.push(formatElapsed(elapsed));
  }

  const header = `[${parts.join(' | ')}]`;
  return `${header} ${msg.text}`;
}
