import type {
  ContentPart,
  ImageBase64ContentPart,
  MessageContent,
  ToolContentPart,
  ToolContentResult,
} from '@cogitator-ai/types';

type ModelImageMediaType = ImageBase64ContentPart['image_base64']['media_type'];

const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set<ModelImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const DATA_URL_PREFIX = /^data:[^,]*;base64,/i;

/**
 * A tool result made of text, images and files, for tools that return media.
 *
 * Text and images reach the model as the tool message's content (an image as an image part, so
 * a vision model sees it). Files, such as synthesized audio, stay with the result for the
 * application and reach the model only as a short description. Base64 data may be given as a
 * `data:` URL; the prefix is removed.
 *
 * @example
 * ```ts
 * execute: async ({ url }) => {
 *   const png = await screenshot(url);
 *   return toolContent({ type: 'text', text: `Screenshot of ${url}` }, { type: 'image', data: png.toString('base64'), mediaType: 'image/png' });
 * }
 * ```
 */
export function toolContent(...parts: ToolContentPart[]): ToolContentResult {
  return {
    type: 'tool-content',
    content: parts.map((part) =>
      part.type === 'text' ? part : { ...part, data: part.data.replace(DATA_URL_PREFIX, '') }
    ),
  };
}

/** Whether a tool result is a {@link ToolContentResult}, as `toolContent()` builds it. */
export function isToolContentResult(value: unknown): value is ToolContentResult {
  if (!isRecord(value) || value.type !== 'tool-content' || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.every(isToolContentPart);
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
        (value.filename === undefined || typeof value.filename === 'string')
      );
    default:
      return false;
  }
}

const IMAGE_PLACEHOLDER = '(image attached)';
const IMAGE_KEYS = ['image', 'imageBase64'] as const;
const IMAGE_SIGNATURES: readonly (readonly [string, ModelImageMediaType])[] = [
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
 * The content of the tool message for a result made of parts: text, with each image as an image
 * part when the model can take it, and a one-line description in place of each file and of
 * images in other formats. A string when there is no image to attach.
 */
export function toolPartsToMessageContent(parts: readonly ToolContentPart[]): MessageContent {
  const content: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image' && MODEL_IMAGE_TYPES.has(part.mediaType)) {
      content.push({
        type: 'image_base64',
        image_base64: { data: part.data, media_type: part.mediaType as ModelImageMediaType },
      });
    } else {
      content.push({ type: 'text', text: describeToolPart(part) });
    }
  }
  if (content.every((part) => part.type === 'text')) {
    return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  }
  return content;
}

/**
 * The text of a result made of parts, with a description in place of every image and file: what
 * guardrails, logs and transcripts read instead of base64 data.
 */
export function toolPartsToText(parts: readonly ToolContentPart[]): string {
  return parts.map(describeToolPart).join('\n');
}

function describeToolPart(part: ToolContentPart): string {
  if (part.type === 'text') return part.text;
  const size = formatBytes(base64ByteLength(part.data));
  if (part.type === 'image') return `[${part.mediaType} image, ${size}]`;
  const name = part.filename ? ` "${part.filename}"` : '';
  return `[${part.mediaType} file${name}, ${size}, delivered to the application, not shown here]`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
