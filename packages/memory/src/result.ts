import type { MemoryResult } from '@cogitator-ai/types';

/**
 * The data of a successful memory call, or an `Error` with the adapter's
 * message when it failed:
 *
 * ```ts
 * const thread = unwrap(await memory.createThread('agent-1'));
 * ```
 */
export function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}
