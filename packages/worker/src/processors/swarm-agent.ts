/**
 * Swarm Agent job processor
 *
 * Executes a single agent turn of a distributed swarm. The returned result always carries
 * the job id so the swarm coordinator can match it; failures are reported as results with
 * an `error` field instead of being thrown.
 */

import type { SwarmAgentJobPayload, SwarmAgentJobResult, WorkerRuntime } from '../types';
import { createAgentFromConfig, resolveRuntime, toErrorMessage } from './shared.js';
import { findToolOutput } from './agent.js';

export async function executeSwarmAgentJob(
  payload: SwarmAgentJobPayload,
  runtime: WorkerRuntime = {}
): Promise<SwarmAgentJobResult> {
  const { jobId, swarmId, agentName, agentConfig, input, context, runOptions } = payload;

  try {
    const resolved = resolveRuntime(runtime);
    const agent = createAgentFromConfig(agentConfig, resolved);
    const result = await resolved.cogitator.run(agent, {
      input,
      context: { ...context, _distributedSwarm: true },
      ...(runOptions?.threadId && { threadId: runOptions.threadId }),
      ...(runOptions?.userId !== undefined && { userId: runOptions.userId }),
      ...(runOptions?.timeout !== undefined && { timeout: runOptions.timeout }),
      ...(runOptions?.saveHistory !== undefined && { saveHistory: runOptions.saveHistory }),
    });

    return {
      type: 'swarm-agent',
      jobId,
      swarmId,
      agentName,
      output: result.output,
      structured: result.structured,
      toolCalls: result.toolCalls.map((tc) => ({
        name: tc.name,
        input: tc.arguments,
        output: findToolOutput(result.messages, tc.id),
      })),
      tokenUsage: {
        prompt: result.usage.inputTokens,
        completion: result.usage.outputTokens,
        total: result.usage.totalTokens,
      },
    };
  } catch (error) {
    return {
      type: 'swarm-agent',
      jobId,
      swarmId,
      agentName,
      output: '',
      toolCalls: [],
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      error: toErrorMessage(error),
    };
  }
}

/**
 * Publishes a job result on the channel the swarm coordinator listens to.
 */
export interface SwarmResultPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface SwarmAgentJobOptions extends WorkerRuntime {
  /** Connection used to publish the result back to the coordinator */
  publisher: SwarmResultPublisher;
  /**
   * Whether a failure is final. Non-final failures are rethrown without publishing so the
   * queue can retry the job (default: true).
   */
  isFinalAttempt?: boolean;
}

/**
 * Execute a swarm agent job and publish its result to `payload.stateKeys.results`.
 * Throws after publishing when the agent failed, so queues mark the job as failed.
 */
export async function processSwarmAgentJob(
  payload: SwarmAgentJobPayload,
  options: SwarmAgentJobOptions
): Promise<SwarmAgentJobResult> {
  const result = await executeSwarmAgentJob(payload, options);
  const isFinal = options.isFinalAttempt ?? true;

  if (result.error === undefined || isFinal) {
    await options.publisher.publish(payload.stateKeys.results, JSON.stringify(result));
  }

  if (result.error !== undefined) {
    throw new Error(result.error);
  }

  return result;
}
