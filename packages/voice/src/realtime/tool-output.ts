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
  /** The images of the result, for a session that sends them to the model */
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
  return truncateToolResultText(JSON.stringify(result ?? null), maxResultLength(tool));
}

function maxResultLength(tool: RealtimeTool): number {
  return tool.maxResultLength ?? DEFAULT_TOOL_RESULT_MAX_LENGTH;
}

function isImagePart(part: ToolContentPart): part is ToolImagePart {
  return part.type === 'image';
}
