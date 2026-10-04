import type { Agent, ResponseFormat } from '@cogitator-ai/types';
import { z } from 'zod';
import type { SerializedAgent, SerializedResponseFormat } from './types';

/**
 * An agent's response format in its queue form: a Zod schema becomes JSON Schema, which the
 * worker turns back into a schema to validate the run's structured output.
 */
export function serializeResponseFormat(
  format: ResponseFormat | undefined
): SerializedResponseFormat | undefined {
  if (format?.type !== 'json_schema') return format;
  const schema = z.toJSONSchema(format.schema, { unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return { type: 'json_schema', schema };
}

/**
 * An agent as a queue job carries it: its model, instructions, sampling, reasoning, response
 * format and the schemas of its tools (the worker resolves tools by name from its own registry).
 *
 * @throws Error when the agent has no model: a queued job cannot fall back to the
 *   submitting process's default model
 */
export function serializeAgent(agent: Agent): SerializedAgent {
  const { config } = agent;
  if (!config.model) {
    throw new Error(`Agent "${agent.name}" has no model; set one before queueing it`);
  }
  const responseFormat = serializeResponseFormat(config.responseFormat);
  return {
    name: agent.name,
    instructions: config.instructions,
    model: config.model,
    ...(config.provider !== undefined && { provider: config.provider }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.topP !== undefined && { topP: config.topP }),
    ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
    ...(config.maxIterations !== undefined && { maxIterations: config.maxIterations }),
    ...(config.reasoning !== undefined && { reasoning: config.reasoning }),
    ...(responseFormat && { responseFormat }),
    tools: agent.tools.map((tool) => tool.toJSON()),
  };
}
