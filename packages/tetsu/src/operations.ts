import { httpError } from '@tetsujs/core';
import type { BaseCtx } from '@tetsujs/core';
import type { Agent } from '@cogitator-ai/core';
import {
  authorizeThreadAccess,
  swarmAgentNames,
  swarmTimeoutWithin,
  withSwarm,
  workflowOptionsWithin,
} from '@cogitator-ai/server-shared';
import type {
  ResumeOptions,
  RunOptions,
  RunResult,
  StrategyResult,
  SwarmConfig,
  SwarmResourceUsage,
  SwarmRunOptions,
  ToolApprovalDecision,
  Workflow,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type { z } from 'zod';
import { importOptional, refusalError } from './errors.js';
import type { ResumeBody } from './schemas.js';
import type {
  AgentListResponseBody,
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

/** Refuses with `403 THREAD_FORBIDDEN` a thread `authorizeThread` keeps the caller from */
export async function checkThreadAccess(
  deps: CogitatorDeps,
  auth: AuthContext | undefined,
  threadId: string | undefined
): Promise<void> {
  const refusal = await authorizeThreadAccess(deps.authorizeThread, auth, threadId);
  if (refusal) throw refusalError(refusal);
}

/** The `deps` of the agent runs of a request, as run options: none without a `deps` hook */
export type RunDeps = Pick<RunOptions, 'deps'>;

/** Builds the `deps` of the agent runs of the request in `ctx` with the `deps` hook */
export async function runDepsOf(deps: CogitatorDeps, ctx: BaseCtx): Promise<RunDeps> {
  return deps.deps ? { deps: await deps.deps(ctx) } : {};
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
      agents: swarmAgentNames(config),
    })),
  };
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

export interface SwarmHandle {
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

/**
 * Runs an agent as the caller, with the `deps` the server built for the request. They come
 * after `options`, so nothing a client sent can stand in for them.
 */
export function runAgent(
  deps: CogitatorDeps,
  agent: Agent,
  options: RunOptions,
  auth: AuthContext | undefined,
  runDeps: RunDeps
): Promise<RunResult> {
  return deps.cogitator.run(agent, {
    ...options,
    ...runDeps,
    ...(auth?.userId !== undefined && { userId: auth.userId }),
  });
}

/**
 * Continues the run paused in `threadId` as the caller, with the `deps` the server built for
 * the request. The runtime refuses a caller who is not the user the run belongs to with
 * `THREAD_ACCESS_DENIED`.
 */
export function resumeAgent(
  deps: CogitatorDeps,
  agent: Agent,
  threadId: string,
  options: ResumeOptions,
  auth: AuthContext | undefined,
  runDeps: RunDeps
): Promise<RunResult> {
  return deps.cogitator.resume(agent, threadId, {
    ...options,
    ...runDeps,
    ...(auth?.userId !== undefined && { userId: auth.userId }),
  });
}

/** Runs a workflow with `maxIterations` and `maxConcurrency` held to the server's limits */
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
    ...workflowOptionsWithin(options, deps.limits),
    signal,
  });
  if (result.error) throw result.error;
  return result;
}

/**
 * Runs a swarm built for this request, its timeout held to the server's limit, and answers
 * with what `finish` makes of it, then closes the swarm, whether the run succeeded, failed or was aborted: a distributed swarm
 * holds two Redis connections and keeps its state without expiry until it is closed.
 */
export async function executeSwarm<T>(
  deps: CogitatorDeps,
  config: SwarmConfig,
  options: SwarmRunOptions,
  auth: AuthContext | undefined,
  signal: AbortSignal,
  finish: (swarm: SwarmHandle, result: StrategyResult) => T
): Promise<T> {
  const { Swarm } = await importOptional(
    () => import('@cogitator-ai/swarms'),
    '@cogitator-ai/swarms'
  );
  signal.throwIfAborted();
  const timeout = swarmTimeoutWithin(options.timeout, deps.limits);
  return withSwarm(new Swarm(deps.cogitator, config), async (swarm) => {
    const abort = () => swarm.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await swarm.run({
        ...options,
        ...(timeout !== undefined && { timeout }),
        ...(auth?.userId !== undefined && { userId: auth.userId }),
      });
      return finish(swarm, result);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  });
}
