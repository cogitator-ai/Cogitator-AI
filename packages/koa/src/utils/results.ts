import type {
  StrategyResult,
  SwarmResourceUsage,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type { SwarmRunResponse, WorkflowRunResponse } from '../types.js';

export interface SerializedSwarmUsage {
  totalTokens: number;
  totalCost: number;
  elapsedTime: number;
  agentUsage: Record<string, { tokens: number; cost: number; runs: number; duration: number }>;
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
