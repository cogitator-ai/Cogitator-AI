import type { Agent } from '@cogitator-ai/types';
import { toAgentWire, toAgentWireResponseFormat } from '@cogitator-ai/core';
import type { SerializedAgent } from './types';

/**
 * An agent's response format in its queue form: a Zod schema becomes JSON Schema, which the
 * worker turns back into a schema to validate the run's structured output.
 */
export const serializeResponseFormat = toAgentWireResponseFormat;

/**
 * An agent as a queue job carries it, in the agent wire format shared with workflow jobs and
 * distributed swarms (`toAgentWire` from `@cogitator-ai/core`): its whole configuration
 * (model and provider, instructions, sampling, stop sequences, reasoning, response format,
 * iteration limit, timeout), the schemas of its tools (the worker resolves tools by name from its
 * own registry) and every agent it can hand over to. An explicit `provider` also prefixes the
 * model, so the job runs on the route the agent takes in-process.
 *
 * @throws AgentWireError when the agent has no model: a queued job cannot fall back to the
 *   submitting process's default model
 */
export function serializeAgent(agent: Agent): SerializedAgent {
  return toAgentWire(agent);
}
