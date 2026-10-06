import { Cogitator, fromAgentWire, type Agent } from '@cogitator-ai/core';
import type { SerializedAgent, WorkerRuntime } from '../types';

/**
 * Worker runtime with the Cogitator settled, so the agents of a job are routed by the
 * same Cogitator that runs them.
 */
export interface ResolvedRuntime extends WorkerRuntime {
  cogitator: Cogitator;
}

export function resolveRuntime(runtime: WorkerRuntime): ResolvedRuntime {
  return { ...runtime, cogitator: runtime.cogitator ?? new Cogitator() };
}

/**
 * The agent a job describes, ready to run on this worker: routed by the worker's Cogitator,
 * with the worker's tool implementations (see `fromAgentWire`).
 *
 * @throws AgentWireError when the config is invalid, needs a tool the worker lacks or a
 *   provider it cannot route to
 */
export function createAgentFromConfig(config: SerializedAgent, runtime: ResolvedRuntime): Agent {
  return fromAgentWire(config, runtime);
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
