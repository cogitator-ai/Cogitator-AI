/**
 * Workflow job processor: a serialized workflow graph run on the workflow executor of
 * `@cogitator-ai/workflows`, over a shared state object, checkpointed for retries
 */

import { z } from 'zod';
import {
  AgentRunPausedError,
  agentWireSchema,
  isPausedRun,
  parseAgentWire,
} from '@cogitator-ai/core';
import { WorkflowExecutor } from '@cogitator-ai/workflows';
import type { Edge, NodeContext, NodeResult, Workflow, WorkflowNode } from '@cogitator-ai/types';
import type {
  ConditionNodeConfig,
  JobUsage,
  SerializedWorkflow,
  SerializedWorkflowEdge,
  SerializedWorkflowNode,
  TransformNodeConfig,
  WorkerRuntime,
  WorkflowJobPayload,
  WorkflowJobResult,
  JobExecutionOptions,
} from '../types';
import { createAgentFromConfig, resolveRuntime, type ResolvedRuntime } from './shared.js';

type WorkflowState = Record<string, unknown>;

const agentNodeSchema = z.object({
  agentConfig: agentWireSchema,
  prompt: z.string().optional(),
  outputKey: z.string().min(1).optional(),
});

const transformNodeSchema = z.object({
  transform: z.enum(['uppercase', 'lowercase', 'trim', 'json-parse', 'json-stringify', 'template']),
  inputKey: z.string().min(1).optional(),
  outputKey: z.string().min(1).optional(),
  template: z.string().optional(),
});

const conditionNodeSchema = z.object({
  key: z.string().min(1),
  operator: z.enum(['equals', 'not-equals', 'contains', 'exists', 'gt', 'lt']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

/**
 * Read a dot-separated path from the workflow state.
 */
export function readStatePath(state: WorkflowState, path: string): unknown {
  let current: unknown = state;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Render `{{path}}` placeholders against the workflow state.
 */
export function renderTemplate(template: string, state: WorkflowState): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path: string) =>
    stringifyValue(readStatePath(state, path))
  );
}

function parseNodeConfig<T>(node: SerializedWorkflowNode, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(node.config);
  if (!parsed.success) {
    throw new Error(
      `Invalid config for ${node.type} node '${node.id}': ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

/**
 * Check the graph before running anything: unique ids, known edge endpoints, branch labels
 * only on condition nodes, valid node configs and no cycles.
 */
export function validateWorkflow(workflow: SerializedWorkflow): void {
  const nodes = new Map<string, SerializedWorkflowNode>();
  for (const node of workflow.nodes) {
    if (nodes.has(node.id)) {
      throw new Error(`Duplicate workflow node id '${node.id}'`);
    }
    nodes.set(node.id, node);
  }

  for (const edge of workflow.edges) {
    const from = nodes.get(edge.from);
    if (!from) throw new Error(`Edge references unknown node '${edge.from}'`);
    if (!nodes.has(edge.to)) throw new Error(`Edge references unknown node '${edge.to}'`);

    if (from.type === 'condition') {
      if (edge.condition !== 'true' && edge.condition !== 'false') {
        throw new Error(
          `Edges leaving condition node '${edge.from}' must set condition to 'true' or 'false'`
        );
      }
    } else if (edge.condition !== undefined) {
      throw new Error(
        `Edge ${edge.from} -> ${edge.to} has a condition but '${edge.from}' is not a condition node`
      );
    }
  }

  for (const node of workflow.nodes) {
    switch (node.type) {
      case 'agent': {
        const config = parseNodeConfig(node, agentNodeSchema);
        try {
          parseAgentWire(config.agentConfig);
        } catch (error) {
          throw new Error(
            `Invalid config for agent node '${node.id}': ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
        break;
      }
      case 'transform': {
        const config = parseNodeConfig(node, transformNodeSchema);
        if (config.transform === 'template' && config.template === undefined) {
          throw new Error(`Transform node '${node.id}' uses 'template' but has no template`);
        }
        break;
      }
      case 'condition':
        parseNodeConfig(node, conditionNodeSchema);
        break;
      case 'parallel':
        break;
    }
  }

  const indegree = new Map(workflow.nodes.map((n) => [n.id, 0]));
  for (const edge of workflow.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = workflow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const edge of workflow.edges.filter((e) => e.from === id)) {
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  if (visited !== workflow.nodes.length) {
    throw new Error(`Workflow '${workflow.name}' contains a cycle`);
  }
}

function evaluateCondition(config: ConditionNodeConfig, state: WorkflowState): boolean {
  const actual = readStatePath(state, config.key);

  switch (config.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return actual === config.value;
    case 'not-equals':
      return actual !== config.value;
    case 'contains':
      if (typeof actual === 'string') return actual.includes(stringifyValue(config.value));
      if (Array.isArray(actual)) return actual.includes(config.value);
      return false;
    case 'gt':
      return (
        typeof actual === 'number' && typeof config.value === 'number' && actual > config.value
      );
    case 'lt':
      return (
        typeof actual === 'number' && typeof config.value === 'number' && actual < config.value
      );
  }
}

function applyTransform(
  config: TransformNodeConfig,
  input: unknown,
  state: WorkflowState
): unknown {
  switch (config.transform) {
    case 'uppercase':
      return stringifyValue(input).toUpperCase();
    case 'lowercase':
      return stringifyValue(input).toLowerCase();
    case 'trim':
      return stringifyValue(input).trim();
    case 'json-parse':
      if (typeof input !== 'string') return input;
      try {
        return JSON.parse(input) as unknown;
      } catch {
        throw new Error('json-parse transform received invalid JSON');
      }
    case 'json-stringify':
      return JSON.stringify(input);
    case 'template':
      return renderTemplate(config.template ?? '', state);
  }
}

/** Prefix of the state keys a run keeps its own bookkeeping under, left out of the output */
const RUN_KEY = '__cogitator:';
const doneKey = (id: string) => `${RUN_KEY}done:${id}`;
const branchKey = (id: string) => `${RUN_KEY}branch:${id}`;
const usageKey = (id: string) => `${RUN_KEY}usage:${id}`;
/** The node a graph with many roots starts from, never one of its own */
const START = `${RUN_KEY}start`;

function outputKeyOf(node: SerializedWorkflowNode): string | undefined {
  if (node.type === 'agent') return parseNodeConfig(node, agentNodeSchema).outputKey ?? node.id;
  if (node.type === 'transform') {
    return parseNodeConfig(node, transformNodeSchema).outputKey ?? node.id;
  }
  return undefined;
}

/**
 * The serialized graph as a workflow of `@cogitator-ai/workflows`. Each node keeps in the state
 * that it ran (`__cogitator:done:<id>`), the branch a condition took (`__cogitator:branch:<id>`)
 * and the usage of an agent run (`__cogitator:usage:<id>`), so a run resumed from a checkpoint
 * knows them too. `abort` stops the agent runs still in flight once a node fails.
 */
function workflowOf(
  serialized: SerializedWorkflow,
  runtime: ResolvedRuntime,
  abort: (reason: unknown) => void
): Workflow<WorkflowState> {
  const byId = new Map(serialized.nodes.map((node) => [node.id, node]));
  const incomingOf = (id: string) => serialized.edges.filter((edge) => edge.to === id);
  const active = (edge: SerializedWorkflowEdge, state: WorkflowState) =>
    state[doneKey(edge.from)] === true &&
    (byId.get(edge.from)?.type !== 'condition' || state[branchKey(edge.from)] === edge.condition);
  const previousOutput = (id: string, state: WorkflowState): unknown => {
    for (const edge of incomingOf(id)) {
      if (!active(edge, state)) continue;
      const from = byId.get(edge.from);
      const key = from ? outputKeyOf(from) : undefined;
      if (key !== undefined) return state[key];
    }
    return undefined;
  };

  const run = async (
    node: SerializedWorkflowNode,
    ctx: NodeContext<WorkflowState> & { signal?: AbortSignal }
  ): Promise<NodeResult<WorkflowState>> => {
    const state = ctx.state;
    const done = { [doneKey(node.id)]: true };
    switch (node.type) {
      case 'agent': {
        const config = parseNodeConfig(node, agentNodeSchema);
        const agent = createAgentFromConfig(config.agentConfig, runtime);
        const prompt = config.prompt
          ? renderTemplate(config.prompt, state)
          : JSON.stringify(withoutRunKeys(state));
        const result = await runtime.cogitator.run(agent, {
          input: prompt,
          ...(ctx.signal && { signal: ctx.signal }),
        });
        if (isPausedRun(result)) {
          throw new AgentRunPausedError(
            result,
            agent.name,
            `workflow "${serialized.name}", node "${node.id}"`
          );
        }
        const answer =
          agent.config.responseFormat?.type === 'json_schema' && result.structured !== undefined
            ? result.structured
            : result.output;
        const usage: JobUsage = {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          cost: result.usage.cost,
          runs: 1,
        };
        return {
          state: { ...done, [config.outputKey ?? node.id]: answer, [usageKey(node.id)]: usage },
          output: answer,
        };
      }
      case 'transform': {
        const config: TransformNodeConfig = parseNodeConfig(node, transformNodeSchema);
        const input =
          config.inputKey !== undefined
            ? readStatePath(state, config.inputKey)
            : previousOutput(node.id, state);
        const value = applyTransform(config, input, state);
        return { state: { ...done, [config.outputKey ?? node.id]: value }, output: value };
      }
      case 'condition': {
        const passed = evaluateCondition(parseNodeConfig(node, conditionNodeSchema), state);
        return {
          state: { ...done, [branchKey(node.id)]: passed ? 'true' : 'false' },
          output: passed,
        };
      }
      case 'parallel':
        return { state: done, output: null };
    }
  };

  const nodes = new Map<string, WorkflowNode<WorkflowState>>();
  for (const node of serialized.nodes) {
    nodes.set(node.id, {
      name: node.id,
      fn: async (ctx) => {
        try {
          return await run(node, ctx as NodeContext<WorkflowState> & { signal?: AbortSignal });
        } catch (error) {
          abort(error);
          throw error;
        }
      },
    });
  }

  const edges: Edge[] = [];
  for (const node of serialized.nodes) {
    const out = serialized.edges.filter((edge) => edge.from === node.id);
    if (out.length === 0) continue;
    if (node.type === 'condition') {
      edges.push({
        type: 'conditional',
        from: node.id,
        targets: [...new Set(out.map((edge) => edge.to))],
        condition: (state) =>
          out
            .filter((edge) => edge.condition === (state as WorkflowState)[branchKey(node.id)])
            .map((edge) => edge.to),
      });
    } else if (out.length === 1) {
      edges.push({ type: 'sequential', from: node.id, to: out[0]!.to });
    } else {
      edges.push({ type: 'parallel', from: node.id, to: out.map((edge) => edge.to) });
    }
  }

  const roots = serialized.nodes.filter((node) => incomingOf(node.id).length === 0);
  let entryPoint = roots[0]?.id ?? START;
  if (roots.length !== 1) {
    nodes.set(START, { name: START, fn: async () => ({ output: null }) });
    if (roots.length > 0) edges.push({ type: 'parallel', from: START, to: roots.map((r) => r.id) });
    entryPoint = START;
  }

  return { name: serialized.name, initialState: {}, nodes, edges, entryPoint };
}

function withoutRunKeys(state: WorkflowState): WorkflowState {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !key.startsWith(RUN_KEY)));
}

/** The usage of the agent runs a finished state recorded */
function usageOf(state: WorkflowState): JobUsage {
  const usage: Required<JobUsage> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    runs: 0,
  };
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith(`${RUN_KEY}usage:`)) continue;
    const one = value as JobUsage;
    usage.inputTokens += one.inputTokens ?? 0;
    usage.outputTokens += one.outputTokens ?? 0;
    usage.totalTokens += one.totalTokens;
    usage.cost += one.cost;
    usage.runs += one.runs;
  }
  return usage;
}

/**
 * Runs a workflow job on the workflow executor of `@cogitator-ai/workflows`: nodes run as soon
 * as the nodes before them settled, independent branches at once, a condition taking its
 * `'true'` or `'false'` edges. With `checkpoints` the run is checkpointed after every node under
 * the job's `runId`, so a retried job (BullMQ attempts) goes on from the last checkpoint instead
 * of running its agents again, and the checkpoints go once the run finished or failed for good.
 */
export async function processWorkflowJob(
  payload: WorkflowJobPayload,
  runtime: WorkerRuntime = {},
  execution: JobExecutionOptions = {}
): Promise<WorkflowJobResult> {
  const started = Date.now();
  validateWorkflow(payload.workflowConfig);
  const resolved = resolveRuntime(runtime);
  const controller = new AbortController();
  const forward = () => controller.abort(execution.signal?.reason);
  if (execution.signal?.aborted) forward();
  execution.signal?.addEventListener('abort', forward, { once: true });
  const workflow = workflowOf(payload.workflowConfig, resolved, (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  });
  const store = runtime.checkpoints;
  const executor = new WorkflowExecutor(resolved.cogitator, store);
  const options = {
    workflowId: payload.runId,
    signal: controller.signal,
    ...(store && { checkpoint: true, checkpointStrategy: 'per-node' as const }),
  };
  const ofRun = async () =>
    store
      ? (await store.list(workflow.name))
          .filter((checkpoint) => checkpoint.workflowId === payload.runId)
          .sort((a, b) => a.timestamp - b.timestamp)
      : [];
  const forget = async () => {
    for (const checkpoint of await ofRun()) await store?.delete(checkpoint.id);
  };

  try {
    const latest = (await ofRun()).at(-1);
    const result = latest
      ? await executor.resume(workflow, latest.id, options)
      : await executor.execute(workflow, payload.input, options);
    if (result.error) throw result.error;
    controller.signal.throwIfAborted();
    await forget();
    const nodeResults: Record<string, unknown> = {};
    for (const node of payload.workflowConfig.nodes) {
      const ran = result.nodeResults.get(node.id);
      nodeResults[node.id] = ran ? ran.output : { skipped: true };
    }
    return {
      type: 'workflow',
      output: withoutRunKeys(result.state),
      nodeResults,
      usage: usageOf(result.state),
      duration: Date.now() - started,
    };
  } catch (error) {
    if (execution.isFinalAttempt !== false) await forget().catch(() => undefined);
    throw error;
  } finally {
    execution.signal?.removeEventListener('abort', forward);
  }
}
