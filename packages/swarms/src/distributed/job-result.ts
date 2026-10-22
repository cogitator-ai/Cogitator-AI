/**
 * How a worker hands the result of a swarm turn back to its coordinator: kept under the job's
 * result key for a while, then published on the swarm's results channel. The coordinator reads
 * the key when the published message did not reach it, such as while its subscriber reconnected.
 */

import type { SwarmAgentJobPayload, SwarmAgentJobResult } from './distributed-coordinator.js';

/** What delivering a result needs of a Redis client; ioredis clients have both */
export interface SwarmResultClient {
  publish(channel: string, message: string): Promise<unknown>;
  /** Without it the result is only published */
  set?(key: string, value: string, mode: 'PX', milliseconds: number): Promise<unknown>;
}

/** How long a result is kept under its key when the job names no `resultTtl` */
export const DEFAULT_SWARM_RESULT_TTL = 3_600_000;

/**
 * Keep the result under `payload.stateKeys.result` (when the job names one and the client can
 * set keys) for `payload.resultTtl` ms, then publish it on `payload.stateKeys.results`. A result
 * that cannot be kept is still published, and `onStoreError` hears why.
 */
export async function deliverSwarmJobResult(
  client: SwarmResultClient,
  payload: SwarmAgentJobPayload,
  result: SwarmAgentJobResult,
  onStoreError?: (error: unknown) => void
): Promise<void> {
  const raw = JSON.stringify(result);
  const key = payload.stateKeys.result;
  if (key && client.set) {
    try {
      await client.set(key, raw, 'PX', resultTtlOf(payload));
    } catch (error) {
      onStoreError?.(error);
    }
  }
  await client.publish(payload.stateKeys.results, raw);
}

/** The ttl a job names, as the whole positive milliseconds Redis takes */
function resultTtlOf(payload: SwarmAgentJobPayload): number {
  const ttl = payload.resultTtl;
  return ttl !== undefined && Number.isFinite(ttl) && ttl > 0
    ? Math.ceil(ttl)
    : DEFAULT_SWARM_RESULT_TTL;
}
