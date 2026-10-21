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

/**
 * The built-in tool `recall_tool_output`, which gets back the output of a tool call that
 * clearing (`context.clearToolOutputs`) replaced with a note. The clearing middleware answers it
 * from the outputs the run cleared itself. Otherwise, as after a paused run resumed, the tool reads
 * the call's `tool_result` entry from the run's own thread in `memory`, never another thread.
 * The Cogitator adds it to an agent's tools when clearing is on.
 *
 * @param memory the memory adapter to read from when the call asks for it, `undefined` when there is none
 */
export function recallToolOutputTool(
  memory: () => MemoryAdapter | undefined = () => undefined
): Tool<RecallToolOutputParams, ToolContentResult> {
  const recall = tool({
    name: RECALL_TOOL_OUTPUT,
    description:
      'Get back the full output of an earlier tool call that was cleared from the conversation to save context. Pass the toolCallId that the note in its place names. Call it only when you need that output again.',
    parameters: recallParams,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ toolCallId }, context) => {
      const adapter = memory();
      if (!adapter || context.threadId === undefined) {
        throw new Error(
          `The output of tool call ${toolCallId} is not held by this run, and there is no memory to read it from`
        );
      }
      const output = await outputInMemory(adapter, context.threadId, toolCallId);
      if (output === undefined) {
        throw new Error(`No output of tool call ${toolCallId} in this conversation`);
      }
      return outputContent(output);
    },
  });
  recallTools.add(recall);
  return recall;
}

/** The output of `toolCallId` as the newest `tool_result` entry of `threadId` holds it. */
async function outputInMemory(
  memory: MemoryAdapter,
  threadId: string,
  toolCallId: string
): Promise<MessageContent | undefined> {
  const read = await memory.getEntries({ threadId, includeToolCalls: true });
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
