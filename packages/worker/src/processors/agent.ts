/**
 * Agent job processor
 *
 * Recreates an Agent from its wire form and runs it, or resumes the run a previous job paused.
 * A paused run is a result, not a failure: it carries `status: 'paused'` and its checkpoint.
 */

import { toAgentWireRunResult } from '@cogitator-ai/core';
import type { AgentJobPayload, AgentJobResult, JobExecutionOptions, WorkerRuntime } from '../types';
import { createAgentFromConfig, resolveRuntime } from './shared.js';

export { findToolOutput } from '@cogitator-ai/core';

/** The run id of a durable agent job, the same for every attempt of the job */
export function durableJobRunId(jobId: string): string {
  return `job:${jobId}`;
}

export async function processAgentJob(
  payload: AgentJobPayload,
  runtime: WorkerRuntime = {},
  execution: JobExecutionOptions = {}
): Promise<AgentJobResult> {
  const { agentConfig, input, threadId, userId, resume } = payload;

  const resolved = resolveRuntime(runtime);
  const agent = createAgentFromConfig(agentConfig, resolved);
  const durable = execution.durable === true && !resume;
  const runId = durableJobRunId(payload.jobId);
  const left = durable
    ? (await resolved.cogitator.durableRuns({ threadId })).find((run) => run.runId === runId)
    : undefined;
  const result = left
    ? await (
        await resolved.cogitator.recoverRun(agent, runId, {
          ...(execution.signal && { signal: execution.signal }),
        })
      ).result
    : resume
      ? await resolved.cogitator.resume(agent, resume.checkpoint ?? threadId, {
          ...(resume.decisions && { decisions: resume.decisions }),
          ...(resume.defaultDecision && { defaultDecision: resume.defaultDecision }),
          ...(resume.responses && { responses: resume.responses }),
          ...(userId !== undefined && { userId }),
          ...(execution.signal && { signal: execution.signal }),
        })
      : await resolved.cogitator.run(agent, {
          input,
          threadId,
          ...(userId !== undefined && { userId }),
          ...(execution.signal && { signal: execution.signal }),
          ...(durable && { durable: true, runId }),
        });

  return {
    type: 'agent',
    ...toAgentWireRunResult(result),
    tokenUsage: {
      prompt: result.usage.inputTokens,
      completion: result.usage.outputTokens,
      total: result.usage.totalTokens,
    },
  };
}
