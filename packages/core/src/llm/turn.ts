import { ErrorCode, type FinishReason, type ToolCall } from '@cogitator-ai/types';
import { LLMError, type LLMErrorContext } from './errors';

/** The end of a model turn: why it stopped and the tool calls it made. */
export interface TurnEnd {
  finishReason: FinishReason;
  toolCalls?: ToolCall[];
}

/**
 * Whether a turn that stopped for `reason` may run tools. Only a turn the model finished can: one
 * cut at the token limit may hold incomplete calls, or not all the calls the model meant to make,
 * and a filtered, refused or failed turn holds nothing to act on. Backends parse tool arguments
 * only for such turns, so a cut-off call is never read as an empty or partial one.
 */
export function finishRunsTools(reason: FinishReason): boolean {
  return reason === 'stop' || reason === 'tool_calls';
}

/**
 * The finish reason of a turn that stopped for `reason`, given whether it made tool calls: a
 * finished turn with calls is a tool turn whatever the provider reported (OpenAI-compatible
 * servers answer a forced tool with `stop`), a finished turn without them is an answer.
 */
export function turnFinishReason(reason: FinishReason, hasToolCalls: boolean): FinishReason {
  if (!finishRunsTools(reason)) return reason;
  return hasToolCalls ? 'tool_calls' : 'stop';
}

/**
 * Settles what a model turn asks for, the same way for every backend. Built-in backends end their
 * turns with it and the runtime applies it to every turn, so a backend of your own gets the same
 * rules:
 * - a finished turn with tool calls is a `tool_calls` turn, whatever the provider reported
 * - a turn cut at the token limit, filtered, refused or failed keeps its reason and loses its
 *   tool calls, which never run
 * - a `tool_calls` stop without any call is a plain answer
 */
export function normalizeTurn<T extends TurnEnd>(turn: T): T {
  const runsTools = finishRunsTools(turn.finishReason);
  const toolCalls = runsTools && turn.toolCalls?.length ? turn.toolCalls : undefined;
  const finishReason = turnFinishReason(turn.finishReason, toolCalls !== undefined);
  if (finishReason === turn.finishReason && toolCalls === turn.toolCalls) return turn;
  const settled: T = { ...turn, finishReason };
  if (toolCalls) settled.toolCalls = toolCalls;
  else delete settled.toolCalls;
  return settled;
}

/** The arguments of a tool call as a backend reads them: an object, or why there is none. */
export type ToolCallArguments = Pick<ToolCall, 'arguments' | 'argumentsError'>;

/**
 * Reads the JSON arguments string of a finished tool call without failing the turn. Empty
 * strings and `null` become `{}`. Anything else that is not a JSON object, such as JSON a
 * provider broke, becomes empty arguments with an `argumentsError`: the runtime does not run
 * such a call and tells the model why, so the model can call again.
 */
export function toolCallArguments(str: string): ToolCallArguments {
  if (!str.trim()) return { arguments: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch {
    return { arguments: {}, argumentsError: `not valid JSON: ${str.slice(0, 200)}` };
  }
  if (parsed === null) return { arguments: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { arguments: {}, argumentsError: `not a JSON object: ${str.slice(0, 200)}` };
  }
  return { arguments: parsed as Record<string, unknown> };
}

/**
 * Parse the JSON arguments string of a tool call into an object. Empty strings and `null` become
 * `{}`; anything else that is not a JSON object fails with `LLM_INVALID_RESPONSE`.
 */
export function parseToolCallArguments(str: string, ctx: LLMErrorContext): Record<string, unknown> {
  if (!str.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch (e) {
    throw new LLMError(
      `Failed to parse tool call arguments: ${str.slice(0, 100)}`,
      ErrorCode.LLM_INVALID_RESPONSE,
      ctx,
      { cause: e instanceof Error ? e : undefined }
    );
  }
  if (parsed === null) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LLMError(
      `Tool call arguments must be a JSON object: ${str.slice(0, 100)}`,
      ErrorCode.LLM_INVALID_RESPONSE,
      ctx
    );
  }
  return parsed as Record<string, unknown>;
}
