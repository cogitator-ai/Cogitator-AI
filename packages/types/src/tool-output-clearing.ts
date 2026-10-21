/**
 * Clearing old tool outputs from a run's conversation, see `ContextManagerConfig.clearToolOutputs`
 */

import type { MessageContent } from './message';
import type { RunMiddlewareContext } from './middleware';

/** A tool call whose output a clearing is about to replace, as `onBeforeClear` gets it. */
export interface ClearedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The arguments the model called the tool with, as the conversation holds them */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The output as the model read it */
  readonly output: MessageContent;
  /** Tokens clearing this call frees: its output, and its arguments with `clearInputs` */
  readonly tokens: number;
}

/** A clearing about to happen, as `onBeforeClear` gets it. */
export interface ToolOutputClearingEvent {
  /** The calls it clears, oldest first */
  readonly calls: readonly ClearedToolCall[];
  /** Tokens of the conversation before it, as the runtime counts them */
  readonly tokens: number;
  /** Tokens it frees in all */
  readonly tokensFreed: number;
  /** The model the turn is for, as the agent names it */
  readonly model: string;
}

/**
 * Clears the outputs of old tool calls from a run's conversation once it grows past `trigger`
 * tokens, the way Anthropic's `clear_tool_uses_20250919` context edit does, but for every
 * provider. A cleared result keeps its message, so each tool call still has its result, with a
 * short note in place of the output that tells the model to get it back with the built-in tool
 * `recall_tool_output`. Clearing runs before compaction, so outputs go before any summary, and it
 * lasts for the rest of the run. Memory keeps every output as it was.
 */
export interface ClearToolOutputsConfig {
  /**
   * Tokens of the conversation a turn sends at which clearing starts (default 100 000). Counted
   * with the runtime's token estimate over the messages, tool schemas aside
   */
  trigger?: number;
  /** How many of the most recent tool results are never cleared (default 3) */
  keep?: number;
  /** Names of tools whose outputs are never cleared */
  exclude?: readonly string[];
  /**
   * Also replace the arguments of the cleared calls in the assistant messages that made them
   * (default false). They cannot be recalled
   */
  clearInputs?: boolean;
  /**
   * Fewest tokens a clearing must free, else nothing is cleared (default 0). Each clearing
   * changes the conversation from the first output it clears on, so the provider's prompt cache
   * of the rest is lost: set it to clear in larger batches when prompt caching matters
   */
  clearAtLeast?: number;
  /**
   * Called before a clearing with the calls it is about to clear, and awaited, so the
   * application can keep what matters from their outputs (in memory, a store, a note) first.
   * An error it throws fails the run
   */
  onBeforeClear?(
    event: ToolOutputClearingEvent,
    context: RunMiddlewareContext
  ): void | Promise<void>;
}
