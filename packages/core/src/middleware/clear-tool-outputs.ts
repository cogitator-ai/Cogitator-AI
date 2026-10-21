import { z } from 'zod';
import {
  countMessageTokens,
  countMessagesTokens,
  countToolCallsTokens,
} from '@cogitator-ai/memory';
import {
  CogitatorError,
  ErrorCode,
  type ClearedToolCall,
  type ClearToolOutputsConfig,
  type Message,
  type MessageContent,
  type RunMiddleware,
  type RunMiddlewareContext,
  type ToolCall,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import {
  isRecallToolOutput,
  outputContent,
  recalledCallId,
  RECALL_TOOL_OUTPUT,
} from '../tools/recall-tool-output';

const optionsSchema = z.object({
  trigger: z.number().int().nonnegative().default(100_000),
  keep: z.number().int().nonnegative().default(3),
  exclude: z.array(z.string()).readonly().default([]),
  clearInputs: z.boolean().default(false),
  clearAtLeast: z.number().int().nonnegative().default(0),
});

const STATE_KEY = 'cogitator:clear-tool-outputs';
const CLEARED_ARGUMENTS_TEXT = 'Arguments cleared to save context';

/** What the clearing of a run did so far, kept in the run's middleware state. */
class ClearingLedger {
  /** The outputs the run cleared, by tool call id, for `recall_tool_output` */
  readonly held = new Map<string, MessageContent>();
  cleared = 0;
  tokensFreed = 0;
  clearings = 0;
}

/** The note a cleared tool output is replaced with. */
export function clearedOutputNote(toolCallId: string): string {
  return `[Output cleared to save context. Call ${RECALL_TOOL_OUTPUT} with {"toolCallId":${JSON.stringify(toolCallId)}} to get it back.]`;
}

/** Whether `args` are the placeholder cleared tool call arguments are replaced with. */
export function isClearedArguments(args: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(args);
  return keys.length === 1 && args.cleared === CLEARED_ARGUMENTS_TEXT;
}

function clearedArguments(): Record<string, unknown> {
  return { cleared: CLEARED_ARGUMENTS_TEXT };
}

/**
 * Span attributes of what clearing did in a run whose middleware shared `state`: how many tool
 * outputs it cleared (`context.cleared_tool_outputs`), the tokens that freed
 * (`context.cleared_tool_output_tokens`) and how many times it cleared (`context.clearings`).
 * Empty when it cleared nothing.
 */
export function clearedToolOutputsAttributes(
  state: ReadonlyMap<string, unknown>
): Record<string, number> {
  const ledger = state.get(STATE_KEY);
  if (!(ledger instanceof ClearingLedger) || ledger.clearings === 0) return {};
  return {
    'context.cleared_tool_outputs': ledger.cleared,
    'context.cleared_tool_output_tokens': ledger.tokensFreed,
    'context.clearings': ledger.clearings,
  };
}

function ledgerOf(context: RunMiddlewareContext): ClearingLedger {
  const existing = context.state.get(STATE_KEY);
  if (existing instanceof ClearingLedger) return existing;
  const ledger = new ClearingLedger();
  context.state.set(STATE_KEY, ledger);
  return ledger;
}

function toolCallsOf(message: Message): ToolCall[] | undefined {
  if (message.role !== 'assistant' || !('toolCalls' in message)) return undefined;
  const calls: unknown = message.toolCalls;
  return Array.isArray(calls) ? calls : undefined;
}

interface Candidate {
  readonly index: number;
  readonly call: ClearedToolCall;
  readonly clearsInput: boolean;
}

/**
 * Clears the outputs of old tool calls from a run's conversation, see `ClearToolOutputsConfig`.
 * Before a turn whose conversation has `trigger` tokens or more, every tool result but the
 * `keep` most recent ones and those of `exclude`d tools gets a note in place of its output, once
 * that frees `clearAtLeast` tokens. Each result keeps its message, so every provider still gets
 * a result for each tool call. The run goes on with the cleared conversation, so a cleared
 * output is not counted again. The middleware answers `recall_tool_output` from the outputs it
 * cleared in the run, and the tool reads memory for the others.
 *
 * The Cogitator adds it from `context.clearToolOutputs`, before compaction, with the
 * `recall_tool_output` tool. To use it on one agent, add it to the agent's `middleware` and
 * `recallToolOutputTool()` to its tools.
 */
export function clearToolOutputsMiddleware(config: ClearToolOutputsConfig = {}): RunMiddleware {
  const parsed = optionsSchema.safeParse(config);
  if (!parsed.success) {
    throw new CogitatorError({
      message: `Invalid context.clearToolOutputs: ${z.prettifyError(parsed.error)}`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  const { trigger, keep, clearInputs, clearAtLeast } = parsed.data;
  const exclude = new Set(parsed.data.exclude);
  const onBeforeClear = config.onBeforeClear;

  const candidatesIn = (messages: readonly Message[]): Candidate[] => {
    const calls = new Map<string, ToolCall>();
    const results: number[] = [];
    messages.forEach((message, index) => {
      for (const call of toolCallsOf(message) ?? []) calls.set(call.id, call);
      if (message.role === 'tool' && message.toolCallId !== undefined) results.push(index);
    });
    const older = keep === 0 ? results : results.slice(0, -keep);
    const candidates: Candidate[] = [];
    for (const index of older) {
      const message = messages[index];
      const toolCallId = message?.toolCallId;
      if (!message || toolCallId === undefined) continue;
      const note = clearedOutputNote(toolCallId);
      if (message.content === note) continue;
      const call = calls.get(toolCallId);
      const toolName = message.name ?? call?.name ?? '';
      if (exclude.has(toolName)) continue;
      const outputTokens =
        countMessageTokens(message) - countMessageTokens({ ...message, content: note });
      if (outputTokens <= 0) continue;
      const clearsInput = clearInputs && call !== undefined && !isClearedArguments(call.arguments);
      const inputTokens = clearsInput
        ? countToolCallsTokens([call]) -
          countToolCallsTokens([{ ...call, arguments: clearedArguments() }])
        : 0;
      candidates.push({
        index,
        call: {
          toolCallId,
          toolName,
          arguments: call?.arguments ?? {},
          output: message.content,
          tokens: outputTokens + Math.max(inputTokens, 0),
        },
        clearsInput,
      });
    }
    return candidates;
  };

  return {
    name: 'cogitator:clear-tool-outputs',
    async beforeModel({ messages, model }, context) {
      const tokens = countMessagesTokens([...messages]);
      if (tokens < trigger) return;
      const candidates = candidatesIn(messages);
      const tokensFreed = candidates.reduce((sum, candidate) => sum + candidate.call.tokens, 0);
      if (candidates.length === 0 || tokensFreed < clearAtLeast) return;

      await onBeforeClear?.(
        {
          calls: candidates.map((candidate) => candidate.call),
          tokens,
          tokensFreed,
          model,
        },
        context
      );

      const ledger = ledgerOf(context);
      const cleared = [...messages];
      const inputsToClear = new Set<string>();
      for (const candidate of candidates) {
        const message = messages[candidate.index];
        if (!message) continue;
        const { toolCallId, output } = candidate.call;
        cleared[candidate.index] = { ...message, content: clearedOutputNote(toolCallId) };
        ledger.held.set(toolCallId, output);
        if (candidate.clearsInput) inputsToClear.add(toolCallId);
      }
      if (inputsToClear.size > 0) {
        cleared.forEach((message, index) => {
          const calls = toolCallsOf(message);
          if (!calls?.some((call) => inputsToClear.has(call.id))) return;
          const toolCalls = calls.map((call) =>
            inputsToClear.has(call.id) ? { ...call, arguments: clearedArguments() } : call
          );
          const replaced: Message & { toolCalls: ToolCall[] } = { ...message, toolCalls };
          cleared[index] = replaced;
        });
      }

      ledger.cleared += candidates.length;
      ledger.tokensFreed += tokensFreed;
      ledger.clearings += 1;
      getLogger().debug('Cleared tool outputs', {
        runId: context.runId,
        cleared: candidates.length,
        tokensFreed,
        tokens,
      });
      return { messages: cleared };
    },
    async wrapToolCall(call, next, context) {
      if (!isRecallToolOutput(call.tool)) return next(call);
      const toolCallId = recalledCallId(call.args);
      const held = toolCallId === undefined ? undefined : ledgerOf(context).held.get(toolCallId);
      if (held === undefined) return next(call);
      return { callId: call.toolCall.id, name: call.toolCall.name, result: outputContent(held) };
    },
  };
}
