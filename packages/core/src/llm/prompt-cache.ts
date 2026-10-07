import type { ChatRequest } from '@cogitator-ai/types';

/** Anthropic's marker for a cache breakpoint, also what OpenRouter takes for Claude. */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/** Where a request marks the prompt cache, see `promptCacheMarks`. */
export interface PromptCacheMarks {
  control: CacheControl;
  /** The stable start of the system prompt, marked at its end */
  systemPrefix?: string;
  /** Whether the end of the conversation is marked too */
  conversation: boolean;
}

/**
 * The cache breakpoints of a request that asks for caching: the end of the stable system prompt
 * (`cachePrefix`), which runs with different input share, and the end of the conversation when
 * another turn is likely to resend it (see `PromptCacheConfig.conversation`). Anthropic allows
 * four breakpoints per request, this uses at most two.
 */
export function promptCacheMarks(request: ChatRequest): PromptCacheMarks | undefined {
  const cache = request.cache;
  if (!cache) return undefined;
  const continues =
    (request.tools?.length ?? 0) > 0 ||
    request.messages.some((message) => message.role === 'assistant');
  return {
    control: { type: 'ephemeral', ...(cache.ttl && { ttl: cache.ttl }) },
    ...(request.cachePrefix?.trim() && { systemPrefix: request.cachePrefix }),
    conversation: cache.conversation ?? continues,
  };
}

/**
 * `system` cut after `prefix`, when it starts with it: the stable part to mark and what the run
 * added after it. Undefined when the system prompt does not open with the prefix, since a
 * breakpoint anywhere else would not be shared between runs.
 */
export function splitSystemPrompt(
  system: string,
  prefix: string
): { stable: string; rest: string } | undefined {
  if (!system.startsWith(prefix)) return undefined;
  return { stable: prefix, rest: system.slice(prefix.length) };
}
