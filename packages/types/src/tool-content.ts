/**
 * Reading tool results that carry media. These helpers have no dependencies, so packages that do
 * not depend on `@cogitator-ai/core`, such as voice sessions, read results the same way a run does.
 */

import type {
  ToolContentPart,
  ToolContentResult,
  ToolOutputContent,
  ToolOutputResult,
  ToolResourcePart,
} from './tool';

/** How many characters of a tool's result the model reads unless configured otherwise. */
export const DEFAULT_TOOL_RESULT_MAX_LENGTH = 100_000;

/** Whether a tool result is a {@link ToolContentResult}, as `toolContent()` builds it. */
export function isToolContentResult(value: unknown): value is ToolContentResult {
  if (!isRecord(value) || value.type !== 'tool-content' || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.every(isToolContentPart);
}

/** Whether a tool result is a {@link ToolOutputResult}, as `toolOutput()` builds it. */
export function isToolOutputResult(value: unknown): value is ToolOutputResult {
  return isRecord(value) && value.type === 'tool-output' && 'content' in value;
}

/**
 * What the model reads of a tool's result: the `content` of a `toolOutput()` result, any other
 * result as it is.
 */
export function toolOutputContent<T>(value: T): ToolOutputContent<T> {
  return (isToolOutputResult(value) ? value.content : value) as ToolOutputContent<T>;
}

function isToolContentPart(value: unknown): value is ToolContentPart {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string';
    case 'image':
      return typeof value.data === 'string' && typeof value.mediaType === 'string';
    case 'file':
      return (
        typeof value.data === 'string' &&
        typeof value.mediaType === 'string' &&
        optionalString(value.filename)
      );
    case 'json':
      return 'value' in value;
    case 'resource':
      return (
        typeof value.uri === 'string' &&
        optionalString(value.name) &&
        optionalString(value.description) &&
        optionalString(value.mediaType) &&
        optionalString(value.text) &&
        optionalString(value.data) &&
        !(value.text !== undefined && value.data !== undefined)
      );
    default:
      return false;
  }
}

const IMAGE_PLACEHOLDER = '(image attached)';
const IMAGE_KEYS = ['image', 'imageBase64'] as const;
const IMAGE_SIGNATURES: readonly (readonly [string, string])[] = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
];
const IMAGE_DATA_URL = /^data:image\/[a-z+.-]+;base64,/i;

/**
 * The parts of a tool result that carries media: a {@link ToolContentResult}, or a result object
 * with a base64 PNG, JPEG, GIF or WebP image (plain or as a `data:` URL) in `image` or
 * `imageBase64`, as browser screenshot tools return. For the latter the rest of the object comes
 * first, as JSON, with the image replaced by a placeholder. `undefined` for any other result.
 */
export function toolResultParts(value: unknown): ToolContentPart[] | undefined {
  if (isToolContentResult(value)) return value.content;
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  for (const key of IMAGE_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const data = raw.replace(IMAGE_DATA_URL, '');
    const mediaType = IMAGE_SIGNATURES.find(([signature]) => data.startsWith(signature))?.[1];
    if (!mediaType) continue;
    const { [key]: _image, ...rest } = value;
    return [
      { type: 'text', text: JSON.stringify({ ...rest, [key]: IMAGE_PLACEHOLDER }) },
      { type: 'image', data, mediaType },
    ];
  }
  return undefined;
}

/**
 * The text of a result made of parts, with a description in place of every image, file and
 * binary resource: what guardrails, logs, transcripts and voice models read instead of base64
 * data. JSON parts become JSON text, text resources their contents under a line naming them.
 */
export function toolPartsToText(parts: readonly ToolContentPart[]): string {
  return parts.map(describeToolPart).join('\n');
}

function describeToolPart(part: ToolContentPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'json':
      return stringifyJson(part.value);
    case 'image':
      return `[${part.mediaType} image, ${formatBytes(base64ByteLength(part.data))}]`;
    case 'file': {
      const name = part.filename ? ` "${part.filename}"` : '';
      return `[${part.mediaType} file${name}, ${formatBytes(base64ByteLength(part.data))}, delivered to the application, not shown here]`;
    }
    case 'resource':
      return describeResource(part);
  }
}

function describeResource(part: ToolResourcePart): string {
  const name = part.name ? `"${part.name}" ` : '';
  const mediaType = part.mediaType ? ` (${part.mediaType})` : '';
  const description = part.description ? ` - ${part.description}` : '';
  const label = `resource ${name}${part.uri}${mediaType}${description}`;
  if (part.text !== undefined) return `[${label}]\n${part.text}`;
  if (part.data !== undefined) {
    return `[${label}, ${formatBytes(base64ByteLength(part.data))}, delivered to the application, not shown here]`;
  }
  return `[${label}]`;
}

/**
 * `text` cut to `maxLength` characters when it is longer: the start and the end are kept (the
 * end often holds the outcome, such as a command's last lines or an error), and a note in the
 * middle tells the model how much was left out. A surrogate pair is never split. A limit that
 * is not a number of zero or more leaves the text whole, a fractional one is rounded down.
 */
export function truncateToolResultText(text: string, maxLength: number): string {
  const cut = toolResultCut([text], maxLength);
  if (!cut) return text;
  const start = text.slice(0, cut.start);
  const end = text.slice(cut.end);
  return [start, cut.note, end].filter(Boolean).join('\n\n');
}

/**
 * Where to cut texts read one after another as a single text of their joined length, as
 * {@link truncateToolResultText} cuts one: the characters from `start` to `end` (offsets into
 * the joined text) are left out, and `note` says so. `undefined` when they fit in `maxLength`.
 */
export function toolResultCut(
  texts: readonly string[],
  maxLength: number
): { start: number; end: number; note: string } | undefined {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (!(maxLength >= 0) || total <= maxLength) return undefined;
  const limit = Math.floor(maxLength);
  let start = Math.ceil(limit * 0.75);
  let end = total - (limit - start);
  if (start > 0 && isHighSurrogate(codeAt(texts, start - 1))) start--;
  if (end < total && isLowSurrogate(codeAt(texts, end))) end++;
  const note = `[... ${end - start} of ${total} characters of this tool result were left out ...]`;
  return { start, end, note };
}

function codeAt(texts: readonly string[], index: number): number {
  let offset = 0;
  for (const text of texts) {
    if (index < offset + text.length) return text.charCodeAt(index - offset);
    offset += text.length;
  }
  return Number.NaN;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

function base64ByteLength(data: string): number {
  const length = data.replace(/\s/g, '').length;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
