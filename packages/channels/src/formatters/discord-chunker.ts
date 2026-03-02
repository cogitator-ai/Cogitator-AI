export interface ChunkDiscordTextOpts {
  maxChars?: number;
  maxLines?: number;
}

interface OpenFence {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
}

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function parseFenceLine(line: string): OpenFence | null {
  const match = FENCE_RE.exec(line);
  if (!match) return null;
  const indent = match[1] ?? '';
  const marker = match[2] ?? '';
  return {
    indent,
    markerChar: marker[0] ?? '`',
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(fence: OpenFence): string {
  return `${fence.indent}${fence.markerChar.repeat(fence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, fence: OpenFence | null): string {
  if (!fence) return text;
  const close = closeFenceLine(fence);
  if (!text) return close;
  if (!text.endsWith('\n')) return `${text}\n${close}`;
  return `${text}${close}`;
}

function splitLongLine(line: string, maxChars: number, preserveWhitespace: boolean): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (line.length <= limit) return [line];

  const out: string[] = [];
  let remaining = line;

  while (remaining.length > limit) {
    if (preserveWhitespace) {
      out.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }

    const window = remaining.slice(0, limit);
    let breakIdx = -1;
    for (let i = window.length - 1; i >= 0; i--) {
      if (/\s/.test(window[i]!)) {
        breakIdx = i;
        break;
      }
    }
    if (breakIdx <= 0) breakIdx = limit;

    out.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx);
  }

  if (remaining.length) out.push(remaining);
  return out;
}

function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const opensWithReasoningItalics =
    source.startsWith('Reasoning:\n_') && source.trimEnd().endsWith('_');
  if (!opensWithReasoningItalics) return chunks;

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = adjusted[i]!;

    if (!current.trimEnd().endsWith('_')) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) break;

    const next = adjusted[i + 1]!;
    const leadingLen = next.length - next.trimStart().length;
    const leading = next.slice(0, leadingLen);
    const body = next.slice(leadingLen);
    if (!body.startsWith('_')) {
      adjusted[i + 1] = `${leading}_${body}`;
    }
  }

  return adjusted;
}

export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));

  const body = text ?? '';
  if (!body) return [];

  if (body.length <= maxChars && countLines(body) <= maxLines) {
    return [body];
  }

  const lines = body.split('\n');
  const chunks: string[] = [];

  let current = '';
  let currentLines = 0;
  let openFence: OpenFence | null = null;

  const flush = () => {
    if (!current) return;
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) chunks.push(payload);
    current = '';
    currentLines = 0;
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
    }
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    let nextOpenFence: OpenFence | null = openFence;

    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
    const reserveLines = nextOpenFence ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;

    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    const segmentLimit = Math.max(1, charLimit - prefixLen);
    const wasInsideFence = openFence !== null;
    const segments = splitLongLine(originalLine, segmentLimit, wasInsideFence);

    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex]!;
      const isLineContinuation = segIndex > 0;
      const delimiter = isLineContinuation ? '' : current.length > 0 ? '\n' : '';
      const addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation) currentLines += 1;
      } else {
        current = segment;
        currentLines = 1;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) chunks.push(payload);
  }

  return rebalanceReasoningItalics(text, chunks);
}
