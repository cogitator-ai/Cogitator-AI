import { z } from 'zod';
import type {
  ContentPart,
  MemoryAdapter,
  MemoryEntry,
  MessageContent,
  Tool,
  ToolContentPart,
  ToolContentResult,
} from '@cogitator-ai/types';
import { tool } from '../tool';
import { toolContent } from '../tool-content';

/** Name of the built-in tool that gets a cleared tool output back. */
export const RECALL_TOOL_OUTPUT = 'recall_tool_output';

const recallParams = z.object({
  toolCallId: z
    .string()
    .min(1)
    .describe(
      'The id of the tool call whose output was cleared, as the note in its place names it'
    ),
});

export type RecallToolOutputParams = z.infer<typeof recallParams>;

const recallTools = new WeakSet<object>();

/** Whether `candidate` is a `recall_tool_output` tool built by {@link recallToolOutputTool}. */
export function isRecallToolOutput(candidate: Tool): boolean {
  return recallTools.has(candidate);
}

/** The `toolCallId` a call of `recall_tool_output` asks for, from its parsed arguments. */
export function recalledCallId(args: unknown): string | undefined {
  const parsed = recallParams.safeParse(args);
  return parsed.success ? parsed.data.toolCallId : undefined;
}

/** Where a run keeps its conversation in memory, for `recall_tool_output` to read from */
export interface RecallPlace {
  threadId: string;
  /**
   * The run's newest entry, whose branch is the run's conversation, null for a run on a branch
   * of its own that holds nothing yet, the thread's active branch when absent
   */
  leafId?: string | null;
}

/**
 * The built-in tool `recall_tool_output`, which gets back the output of a tool call that
 * clearing (`context.clearToolOutputs`) replaced with a note. The clearing middleware answers it
 * from the outputs the run cleared itself. Otherwise, as after a paused run resumed, the tool reads
 * the call's `tool_result` entry from the branch the run is on in `memory`: only a run that uses
 * memory and was let on its thread has a place, so the tool never reads another thread or branch.
 * The Cogitator adds it to an agent's tools when clearing is on.
 *
 * @param memory the memory adapter to read from when the call asks for it, `undefined` when there is none
 * @param placeOf where the run with this id keeps its conversation, `undefined` for a run that
 *   uses no memory
 */
export function recallToolOutputTool(
  memory: () => MemoryAdapter | undefined = () => undefined,
  placeOf: (runId: string) => RecallPlace | undefined = () => undefined
): Tool<RecallToolOutputParams, ToolContentResult> {
  const recall = tool({
    name: RECALL_TOOL_OUTPUT,
    description:
      'Get back the full output of an earlier tool call that was cleared from the conversation to save context. Pass the toolCallId that the note in its place names. Call it only when you need that output again.',
    parameters: recallParams,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ toolCallId }, context) => {
      const adapter = memory();
      const place = placeOf(context.runId);
      if (!adapter || !place) {
        throw new Error(
          `The output of tool call ${toolCallId} is not held by this run, and the run keeps no memory to read it from`
        );
      }
      const output = await outputInMemory(adapter, place, toolCallId);
      if (output === undefined) {
        throw new Error(`No output of tool call ${toolCallId} in this conversation`);
      }
      return outputContent(output);
    },
  });
  recallTools.add(recall);
  return recall;
}

/**
 * The output of `toolCallId` as the newest `tool_result` entry on the run's branch holds it, of
 * the whole thread with an adapter that keeps no branches
 */
async function outputInMemory(
  memory: MemoryAdapter,
  place: RecallPlace,
  toolCallId: string
): Promise<MessageContent | undefined> {
  if (place.leafId === null) return undefined;
  const leafId = place.leafId;
  const read = memory.getPath
    ? await memory.getPath({
        threadId: place.threadId,
        ...(leafId !== undefined && { leafId }),
        types: ['tool_result'],
        includeToolCalls: true,
      })
    : await memory.getEntries({ threadId: place.threadId, includeToolCalls: true });
  if (!read.success) {
    throw new Error(`Could not read the conversation from memory: ${read.error}`);
  }
  for (let index = read.data.length - 1; index >= 0; index--) {
    const entry = read.data[index];
    if (entry && answers(entry, toolCallId)) return entry.message.content;
  }
  return undefined;
}

function answers(entry: MemoryEntry, toolCallId: string): boolean {
  if (entry.message.role !== 'tool') return false;
  return (
    entry.message.toolCallId === toolCallId ||
    (entry.toolResults ?? []).some((result) => result.callId === toolCallId)
  );
}

/** A tool output as the model read it, as a result that gives it to the model the same way. */
export function outputContent(output: MessageContent): ToolContentResult {
  if (typeof output === 'string') return toolContent({ type: 'text', text: output });
  return toolContent(...output.map(contentPart));
}

function contentPart(part: ContentPart): ToolContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image_base64':
      return {
        type: 'image',
        data: part.image_base64.data,
        mediaType: part.image_base64.media_type,
      };
    case 'image_url':
      return { type: 'resource', uri: part.image_url.url };
  }
}
