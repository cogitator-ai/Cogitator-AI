import type { Usage } from './protocol.js';

/**
 * Token usage of a finished agent run, as every adapter answers it.
 *
 * The provider-specific counts are present only when the model reported them.
 */
export interface RunUsage extends Usage {
  /** Hidden reasoning tokens, already counted in `outputTokens` */
  reasoningTokens?: number;
  /** Input tokens read from the provider's prompt cache, already counted in `inputTokens` */
  cachedInputTokens?: number;
  /** Input tokens written to the provider's prompt cache, already counted in `inputTokens` */
  cacheWriteTokens?: number;
}

/**
 * The client-facing usage of a run: the token counts of core's `RunResult.usage`,
 * without its cost and duration, keeping only the optional counts the model reported.
 */
export function toRunUsage(usage: Readonly<RunUsage>): RunUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cachedInputTokens !== undefined && { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
  };
}
