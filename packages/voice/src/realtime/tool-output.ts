import {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  toolPartsToText,
  toolResultParts,
  truncateToolResultText,
  type ToolContentPart,
  type ToolImagePart,
} from '@cogitator-ai/types';
import type { RealtimeTool } from '../types.js';

/** A tool result made of parts (`toolContent()`, a screenshot object), read for a voice model. */
export interface RealtimeToolParts {
  /** What the model reads: text, JSON and text resources, with images and files described */
  text: string;
  /** The PNG, JPEG, GIF and WebP images of the result, for a session that sends them */
  images: ToolImagePart[];
}

/**
 * The parts of a tool result, as a voice model reads them: the text of the parts, cut to the
 * tool's `maxResultLength` (default 100 000 characters), and the images apart. `undefined` for a
 * result without parts, which each provider sends in its own form.
 */
export function realtimeToolParts(
  result: unknown,
  tool: RealtimeTool
): RealtimeToolParts | undefined {
  const parts = toolResultParts(result);
  if (!parts) return undefined;
  return {
    text: truncateToolResultText(toolPartsToText(parts), maxResultLength(tool)),
    images: parts.filter(isImagePart),
  };
}

/** A tool result without parts as JSON text, cut to the tool's `maxResultLength`. */
export function realtimeToolText(result: unknown, tool: RealtimeTool): string {
  return truncateToolResultText(toJson(result), maxResultLength(tool));
}

/**
 * A tool result without parts as a value for a provider that takes JSON (Gemini): the value
 * itself, or its JSON text cut to the tool's `maxResultLength` when that text is longer.
 */
export function realtimeToolValue(result: unknown, tool: RealtimeTool): unknown {
  const json = toJson(result);
  const max = maxResultLength(tool);
  return json.length > max ? truncateToolResultText(json, max) : (JSON.parse(json) as unknown);
}

function maxResultLength(tool: RealtimeTool): number {
  return tool.maxResultLength ?? DEFAULT_TOOL_RESULT_MAX_LENGTH;
}

/** JSON text of a result, `null` for what JSON cannot hold (a function, `undefined`). */
function toJson(result: unknown): string {
  return JSON.stringify(result ?? null) ?? 'null';
}

const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function isImagePart(part: ToolContentPart): part is ToolImagePart {
  return part.type === 'image' && MODEL_IMAGE_TYPES.has(part.mediaType);
}
