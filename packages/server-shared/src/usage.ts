import type { Usage } from './protocol.js';

/**
 * Token usage of a finished agent run, as every adapter answers it, in the JSON run
 * response and in the stream's `finish` event alike.
 */
export type RunUsage = Usage;

/**
 * The client-facing usage of a run: the token counts of core's `RunResult.usage`,
 * without its cost and duration, keeping only the optional counts the model reported.
 */
export function toRunUsage(usage: Readonly<Usage>): RunUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cachedInputTokens !== undefined && { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
  };
}
