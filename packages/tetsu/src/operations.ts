import { httpError } from '@tetsujs/core';
import type { Agent } from '@cogitator-ai/core';
import { toRunUsage, type PendingApproval } from '@cogitator-ai/server-shared';
import type {
  ResumeOptions,
  RunOptions,
  RunResult,
  StrategyResult,
  SwarmConfig,
  SwarmResourceUsage,
  SwarmRunOptions,
  ToolApprovalDecision,
  ToolApprovalRequest,
  Workflow,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type { z } from 'zod';
import { importOptional } from './errors.js';
import type { ResumeBody } from './schemas.js';
import type {
  AgentListResponseBody,
  AgentRunResponseBody,
  AuthContext,
  CogitatorDeps,
  SwarmListResponseBody,
  SwarmRunResponseBody,
  ToolListResponseBody,
  WorkflowListResponseBody,
  WorkflowRunResponseBody,
} from './types.js';

function getOwn<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function findAgent(deps: CogitatorDeps, name: string): Agent {
  const agent = getOwn(deps.agents, name);
  if (!agent) throw httpError(404, 'AGENT_NOT_FOUND', `Agent '${name}' not found`);
  return agent;
}

export function findWorkflow(deps: CogitatorDeps, name: string): Workflow<WorkflowState> {
  const workflow = getOwn(deps.workflows, name);
  if (!workflow) throw httpError(404, 'WORKFLOW_NOT_FOUND', `Workflow '${name}' not found`);
  return workflow;
}

export function findSwarm(deps: CogitatorDeps, name: string): SwarmConfig {
  const swarm = getOwn(deps.swarms, name);
  if (!swarm) throw httpError(404, 'SWARM_NOT_FOUND', `Swarm '${name}' not found`);
  return swarm;
}

export async function checkThreadAccess(
  deps: CogitatorDeps,
  auth: AuthContext | undefined,
  threadId: string | undefined
): Promise<void> {
  if (threadId === undefined || !deps.authorizeThread) return;
  if (!(await deps.authorizeThread(auth, threadId))) {
    throw httpError(403, 'THREAD_FORBIDDEN', `Access to thread '${threadId}' is not allowed`);
  }
}

export function listAgents(deps: CogitatorDeps): AgentListResponseBody {
  return {
    agents: Object.entries(deps.agents ?? {}).map(([name, agent]) => ({
      name,
      ...(agent.config.description !== undefined && { description: agent.config.description }),
      tools: agent.config.tools?.map((tool) => tool.name) ?? [],
    })),
  };
}

export function listTools(deps: CogitatorDeps): ToolListResponseBody {
  const tools = new Map<string, ToolListResponseBody['tools'][number]>();
  for (const agent of Object.values(deps.agents ?? {})) {
    for (const tool of agent.config.tools ?? []) {
      if (tools.has(tool.name)) continue;
      const schema = tool.toJSON();
      tools.set(tool.name, {
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
      });
    }
  }
  return { tools: [...tools.values()] };
}

export function listWorkflows(deps: CogitatorDeps): WorkflowListResponseBody {
  return {
    workflows: Object.entries(deps.workflows ?? {}).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: [...workflow.nodes.keys()],
    })),
  };
}

export function listSwarms(deps: CogitatorDeps): SwarmListResponseBody {
  return {
    swarms: Object.entries(deps.swarms ?? {}).map(([name, config]) => ({
      name,
      strategy: config.strategy,
      agents: [
        ...(config.supervisor ? [config.supervisor.name] : []),
        ...(config.workers ?? []).map((agent) => agent.name),
        ...(config.agents ?? []).map((agent) => agent.name),
        ...(config.moderator ? [config.moderator.name] : []),
      ],
    })),
  };
}

export function toAgentRunResponse(result: RunResult): AgentRunResponseBody {
  return {
    output: result.output,
    ...(result.structured !== undefined && { structured: result.structured }),
    threadId: result.threadId,
    usage: toRunUsage(result.usage),
    toolCalls: result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    ...(result.reasoning !== undefined && { reasoning: result.reasoning }),
    ...(result.status !== undefined && { status: result.status }),
    ...(result.pendingApprovals !== undefined && {
      pendingApprovals: toPendingApprovals(result.pendingApprovals),
    }),
  };
}

/** The tool calls a paused run waits on, as clients see them. */
export function toPendingApprovals(requests: readonly ToolApprovalRequest[]): PendingApproval[] {
  return requests.map((request) => ({
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    arguments: request.arguments,
    description: request.description,
    ...(request.sideEffects !== undefined && { sideEffects: [...request.sideEffects] }),
  }));
}

function toDecision(decision: { approved: boolean; reason?: string }): ToolApprovalDecision {
  if (decision.approved) return { approved: true };
  return decision.reason === undefined
    ? { approved: false }
    : { approved: false, reason: decision.reason };
}

/** The decisions of a resume request, as `cogitator.resume()` takes them. */
export function toResumeDecisions(
  body: Pick<z.output<typeof ResumeBody>, 'decisions' | 'defaultDecision'>
): Pick<ResumeOptions, 'decisions' | 'defaultDecision'> {
  return {
    ...(body.decisions && {
      decisions: Object.fromEntries(
        Object.entries(body.decisions).map(([id, decision]) => [id, toDecision(decision)])
      ),
    }),
    ...(body.defaultDecision && { defaultDecision: toDecision(body.defaultDecision) }),
  };
}

export function toWorkflowRunResponse(
  result: WorkflowResult<WorkflowState>
): WorkflowRunResponseBody {
  return {
    workflowId: result.workflowId,
    workflowName: result.workflowName,
    state: result.state,
    duration: result.duration,
    nodeResults: Object.fromEntries(result.nodeResults),
  };
}

export function serializeSwarmUsage(usage: SwarmResourceUsage) {
  return {
    totalTokens: usage.totalTokens,
    totalCost: usage.totalCost,
    elapsedTime: usage.elapsedTime,
    agentUsage: Object.fromEntries(usage.agentUsage),
  };
}

interface SwarmHandle {
  readonly id: string;
  readonly name: string;
  readonly strategyType: string;
  getResourceUsage(): SwarmResourceUsage;
}

export function toSwarmRunResponse(
  swarm: SwarmHandle,
  result: StrategyResult
): SwarmRunResponseBody {
  const usage = swarm.getResourceUsage();
  return {
    swarmId: swarm.id,
    swarmName: swarm.name,
    strategy: swarm.strategyType,
    output: result.output,
    agentResults: Object.fromEntries(
      [...result.agentResults].map(([name, run]) => [
        name,
        { output: run.output, usage: { ...run.usage } },
      ])
    ),
    usage: {
      totalTokens: usage.totalTokens,
      totalCost: usage.totalCost,
      elapsedTime: usage.elapsedTime,
    },
  };
}

export function runAgent(
  deps: CogitatorDeps,
  agent: Agent,
  options: RunOptions,
  auth: AuthContext | undefined
): Promise<RunResult> {
  return deps.cogitator.run(agent, {
    ...options,
    ...(auth?.userId !== undefined && { userId: auth.userId }),
  });
}

/**
 * Continues the run paused in `threadId` as the caller. The runtime refuses a
 * caller who is not the user the run belongs to with `THREAD_ACCESS_DENIED`.
 */
export function resumeAgent(
  deps: CogitatorDeps,
  agent: Agent,
  threadId: string,
  options: ResumeOptions,
  auth: AuthContext | undefined
): Promise<RunResult> {
  return deps.cogitator.resume(agent, threadId, {
    ...options,
    ...(auth?.userId !== undefined && { userId: auth.userId }),
  });
}

export async function executeWorkflow(
  deps: CogitatorDeps,
  workflow: Workflow<WorkflowState>,
  input: Record<string, unknown> | undefined,
  options: WorkflowExecuteOptions,
  signal: AbortSignal
): Promise<WorkflowResult<WorkflowState>> {
  const { WorkflowExecutor } = await importOptional(
    () => import('@cogitator-ai/workflows'),
    '@cogitator-ai/workflows'
  );
  const result = await new WorkflowExecutor(deps.cogitator).execute(workflow, input, {
    ...options,
    signal,
  });
  if (result.error) throw result.error;
  return result;
}

export async function executeSwarm(
  deps: CogitatorDeps,
  config: SwarmConfig,
  options: SwarmRunOptions,
  auth: AuthContext | undefined,
  signal: AbortSignal,
  onStart?: (swarm: SwarmHandle) => void
): Promise<{ swarm: SwarmHandle; result: StrategyResult }> {
  const { Swarm } = await importOptional(
    () => import('@cogitator-ai/swarms'),
    '@cogitator-ai/swarms'
  );
  signal.throwIfAborted();
  const swarm = new Swarm(deps.cogitator, config);
  const abort = () => swarm.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    onStart?.(swarm);
    const result = await swarm.run({
      ...options,
      ...(auth?.userId !== undefined && { userId: auth.userId }),
    });
    return { swarm, result };
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
