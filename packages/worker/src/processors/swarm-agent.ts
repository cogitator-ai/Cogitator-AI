/**
 * Swarm Agent job processor
 *
 * Executes a single agent within a distributed swarm context.
 * Reads shared state from Redis and publishes results back.
 */

import { Cogitator, Agent } from '@cogitator-ai/core';
import Redis from 'ioredis';
import type { ToolSchema } from '@cogitator-ai/types';
import type { SwarmAgentJobPayload, SwarmAgentJobResult } from '../types.js';
import { recreateTools } from './shared.js';

export async function processSwarmAgentJob(
  payload: SwarmAgentJobPayload
): Promise<SwarmAgentJobResult> {
  const { swarmId, agentName, agentConfig, input, context, stateKeys } = payload;

  let redis: Redis | null = null;

  try {
    const cogitator = new Cogitator();
    const tools = recreateTools(agentConfig.tools as ToolSchema[]);

    const agent = new Agent({
      name: agentConfig.name,
      model: `${agentConfig.provider}/${agentConfig.model}`,
      instructions: agentConfig.instructions,
      temperature: agentConfig.temperature,
      maxTokens: agentConfig.maxTokens,
      tools,
    });

    const result = await cogitator.run(agent, {
      input,
      context: {
        ...context,
        _distributedSwarm: true,
      },
    });

    const jobResult: SwarmAgentJobResult = {
      type: 'swarm-agent',
      swarmId,
      agentName,
      output: result.output,
      structured: result.structured,
      toolCalls: result.toolCalls.map((tc) => ({
        name: tc.name,
        input: tc.arguments,
        output: undefined,
      })),
      tokenUsage: {
        prompt: result.usage.inputTokens,
        completion: result.usage.outputTokens,
        total: result.usage.totalTokens,
      },
    };

    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      password: process.env.REDIS_PASSWORD,
    });

    await redis.publish(stateKeys.results, JSON.stringify(jobResult));

    return jobResult;
  } catch (error) {
    const errorResult: SwarmAgentJobResult = {
      type: 'swarm-agent',
      swarmId,
      agentName,
      output: '',
      toolCalls: [],
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    if (!redis) {
      redis = new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
        password: process.env.REDIS_PASSWORD,
      });
    }

    await redis.publish(stateKeys.results, JSON.stringify(errorResult));

    throw error;
  } finally {
    if (redis) {
      await redis.quit();
    }
  }
}
