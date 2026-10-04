import type {
  RunResult,
  StrategyResult,
  SwarmResourceUsage,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import { toRunUsage } from '@cogitator-ai/server-shared';
import type { AgentRunResponse, SwarmRunResponse, WorkflowRunResponse } from '../types.js';

export interface SerializedSwarmUsage {
  totalTokens: number;
  totalCost: number;
  elapsedTime: number;
  agentUsage: Record<string, { tokens: number; cost: number; runs: number; duration: number }>;
}

/** The client-facing shape of a run; never carries the paused run's checkpoint */
export function toAgentRunResponse(result: RunResult): AgentRunResponse {
  return {
    output: result.output,
    threadId: result.threadId,
    usage: toRunUsage(result.usage),
    toolCalls: [...result.toolCalls],
    ...(result.reasoning && { reasoning: result.reasoning }),
    status: result.status ?? 'completed',
    ...(result.pendingApprovals && { pendingApprovals: [...result.pendingApprovals] }),
  };
}

export function withoutCheckpoint(result: RunResult): Omit<RunResult, 'checkpoint'> {
  const { checkpoint: _checkpoint, ...rest } = result;
  return rest;
}

export function toWorkflowRunResponse(result: WorkflowResult<WorkflowState>): WorkflowRunResponse {
  return {
    workflowId: result.workflowId,
    workflowName: result.workflowName,
    state: result.state,
    duration: result.duration,
    nodeResults: Object.fromEntries(result.nodeResults),
  };
}

export function serializeSwarmUsage(usage: SwarmResourceUsage): SerializedSwarmUsage {
  return {
    totalTokens: usage.totalTokens,
    totalCost: usage.totalCost,
    elapsedTime: usage.elapsedTime,
    agentUsage: Object.fromEntries(usage.agentUsage),
  };
}

export function toSwarmRunResponse(
  swarm: { id: string; name: string; strategyType: string; getResourceUsage(): SwarmResourceUsage },
  result: StrategyResult
): SwarmRunResponse {
  const agentResults: Record<string, unknown> = {};
  for (const [agentName, agentResult] of result.agentResults) {
    agentResults[agentName] = { output: agentResult.output, usage: agentResult.usage };
  }

  const usage = swarm.getResourceUsage();
  return {
    swarmId: swarm.id,
    swarmName: swarm.name,
    strategy: swarm.strategyType,
    output: result.output,
    agentResults,
    usage: {
      totalTokens: usage.totalTokens,
      totalCost: usage.totalCost,
      elapsedTime: usage.elapsedTime,
    },
  };
}
