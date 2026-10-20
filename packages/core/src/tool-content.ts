import {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  isToolContentResult,
  toolPartsToText,
  toolResultCut,
  toolResultParts,
  truncateToolResultText,
  type ContentPart,
  type ImageBase64ContentPart,
  type MessageContent,
  type ToolContentPart,
  type ToolContentResult,
} from '@cogitator-ai/types';

export {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  isToolContentResult,
  toolPartsToText,
  toolResultParts,
  truncateToolResultText,
};

type ModelImageMediaType = ImageBase64ContentPart['image_base64']['media_type'];

const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set<ModelImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const DATA_URL_PREFIX = /^data:[^,]*;base64,/i;

/**
 * A tool result made of text, structured data, resources, images and files, for tools that
 * return more than one value or media.
 *
 * Text, JSON and text resources reach the model as the tool message's content, images as image
 * parts (so a vision model sees them). Files and binary resources, such as synthesized audio,
 * stay with the result for the application and reach the model only as a short description.
 * Base64 data may be given as a `data:` URL, whose prefix is removed.
 *
 * @example
 * ```ts
 * execute: async ({ url }) => {
 *   const png = await screenshot(url);
 *   return toolContent(
 *     { type: 'json', value: { url, status: 200 } },
 *     { type: 'image', data: png.toString('base64'), mediaType: 'image/png' }
 *   );
 * }
 * ```
 */
export function toolContent(...parts: ToolContentPart[]): ToolContentResult {
  return { type: 'tool-content', content: parts.map(withoutDataUrlPrefix) };
}

function withoutDataUrlPrefix(part: ToolContentPart): ToolContentPart {
  switch (part.type) {
    case 'image':
    case 'file':
      return { ...part, data: part.data.replace(DATA_URL_PREFIX, '') };
    case 'resource':
      return part.data === undefined
        ? part
        : { ...part, data: part.data.replace(DATA_URL_PREFIX, '') };
    default:
      return part;
  }
}

/**
 * The content of the tool message for a result made of parts: text, with each image as an image
 * part when the model can take it, and a description in place of each file, binary resource
 * and image in other formats, without empty text parts, which some providers refuse next to an
 * image. A string when there is no image to attach. The text parts are cut
 * to `maxLength` characters in all as one text (see `truncateToolResultText`): the start and the
 * end are kept, parts in between are left out, images stay.
 */
export function toolPartsToMessageContent(
  parts: readonly ToolContentPart[],
  maxLength = DEFAULT_TOOL_RESULT_MAX_LENGTH
): MessageContent {
  const content: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image' && MODEL_IMAGE_TYPES.has(part.mediaType)) {
      content.push({
        type: 'image_base64',
        image_base64: { data: part.data, media_type: part.mediaType as ModelImageMediaType },
      });
    } else {
      content.push({ type: 'text', text: toolPartsToText([part]) });
    }
  }
  if (content.every((part) => part.type === 'text')) {
    const text = content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return truncateToolResultText(text, maxLength);
  }
  return cutTextParts(
    content.filter((part) => part.type !== 'text' || part.text !== ''),
    maxLength
  );
}

function cutTextParts(content: ContentPart[], maxLength: number): ContentPart[] {
  const texts = content.map((part) => (part.type === 'text' ? part.text : ''));
  const cut = toolResultCut(texts, maxLength);
  if (!cut) return content;
  const result: ContentPart[] = [];
  let offset = 0;
  let noted = false;
  for (const part of content) {
    if (part.type !== 'text') {
      result.push(part);
      continue;
    }
    const start = offset;
    offset += part.text.length;
    if (offset <= cut.start || start >= cut.end) {
      result.push(part);
      continue;
    }
    const head = part.text.slice(0, Math.max(0, cut.start - start));
    const tail = part.text.slice(Math.min(part.text.length, cut.end - start));
    const text = [head, noted ? '' : cut.note, tail].filter(Boolean).join('\n\n');
    noted = true;
    if (text) result.push({ type: 'text', text });
  }
  return result;
}

/**
 * Why a limit on the characters of a result the model reads is invalid, or `undefined` when it is
 * a positive integer (or `Infinity`). A negative or `NaN` limit would otherwise mean no limit at
 * all, and `0` a result reduced to the note, without a word.
 */
export function toolResultLengthError(
  value: number | undefined,
  field: string
): string | undefined {
  if (value === undefined || value === Infinity || (Number.isInteger(value) && value > 0)) {
    return undefined;
  }
  return `${field} must be a positive integer (characters of a tool result the model reads), got ${String(value)}`;
}
