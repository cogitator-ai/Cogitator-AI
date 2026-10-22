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
import type {
  CheckpointStore,
  Edge,
  NodeContext,
  NodeResult,
  Workflow,
  WorkflowCheckpoint,
  WorkflowNode,
} from '@cogitator-ai/types';
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

/** Prefix of the state keys a run keeps its own bookkeeping under, left out of the output */
const RUN_KEY = '__cogitator:';
const doneKey = (id: string) => `${RUN_KEY}done:${id}`;
const branchKey = (id: string) => `${RUN_KEY}branch:${id}`;
const usageKey = (id: string) => `${RUN_KEY}usage:${id}`;
/** The node a graph with many roots starts from, never one of its own */
const START = `${RUN_KEY}start`;

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
 * only on condition nodes, valid node configs and no cycles. Node ids and output keys must not
 * start with `__cogitator:`, the prefix of the run's own state keys.
 */
export function validateWorkflow(workflow: SerializedWorkflow): void {
  const nodes = new Map<string, SerializedWorkflowNode>();
  for (const node of workflow.nodes) {
    if (nodes.has(node.id)) {
      throw new Error(`Duplicate workflow node id '${node.id}'`);
    }
    if (node.id.startsWith(RUN_KEY)) {
      throw new Error(`Workflow node id '${node.id}' starts with '${RUN_KEY}', kept for the run`);
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
        refuseRunKey(node, config.outputKey);
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
        refuseRunKey(node, config.outputKey);
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

function refuseRunKey(node: SerializedWorkflowNode, outputKey: string | undefined): void {
  if (outputKey?.startsWith(RUN_KEY)) {
    throw new Error(
      `Output key '${outputKey}' of node '${node.id}' starts with '${RUN_KEY}', kept for the run`
    );
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
 * knows them too. Agent runs stop on `ctx.signal` and on `siblings`, which a failing node aborts
 * so the runs still in flight next to it stop too.
 */
function workflowOf(
  serialized: SerializedWorkflow,
  runtime: ResolvedRuntime,
  siblings: AbortController
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
          signal: ctx.signal ? AbortSignal.any([ctx.signal, siblings.signal]) : siblings.signal,
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
          if (!siblings.signal.aborted) siblings.abort(error);
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
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith(`${RUN_KEY}usage:`) || typeof value !== 'object' || value === null)
      continue;
    const one = value as Partial<Record<keyof JobUsage, unknown>>;
    usage.inputTokens += count(one.inputTokens);
    usage.outputTokens += count(one.outputTokens);
    usage.totalTokens += count(one.totalTokens);
    usage.cost += count(one.cost);
    usage.runs += count(one.runs);
  }
  return usage;
}

/**
 * Id of the one checkpoint a workflow job keeps, saved over after every node: the job's id and
 * its `runId`, so jobs sharing a `runId` never resume from each other
 */
export function workflowCheckpointId(payload: Pick<WorkflowJobPayload, 'jobId' | 'runId'>): string {
  return `workflow-job:${payload.jobId}:run:${payload.runId}`;
}

/** Delete the checkpoint of a workflow job, for a run no attempt goes on from */
export async function forgetWorkflowRun(
  payload: Pick<WorkflowJobPayload, 'jobId' | 'runId'>,
  store: CheckpointStore
): Promise<void> {
  await store.delete(workflowCheckpointId(payload));
}

/**
 * The store as the executor of one job sees it: every checkpoint saved under the job's id, one
 * after the other so the last one saved is the newest, and a failed save aborts the agent runs
 * in flight before it fails the job
 */
function storeOfJob(
  store: CheckpointStore,
  id: string,
  siblings: AbortController
): CheckpointStore {
  let saving: Promise<void> = Promise.resolve();
  return {
    save(checkpoint: WorkflowCheckpoint) {
      const saved = saving.then(() => store.save({ ...checkpoint, id }));
      saving = saved.catch(() => undefined);
      return saved.catch((error: unknown) => {
        if (!siblings.signal.aborted) siblings.abort(error);
        throw error;
      });
    },
    load: (checkpointId) => store.load(checkpointId),
    list: (name) => store.list(name),
    delete: (checkpointId) => store.delete(checkpointId),
  };
}

/**
 * Runs a workflow job on the workflow executor of `@cogitator-ai/workflows`, over a shared state:
 * in rounds, each running at once the nodes whose nodes before them all settled, a condition
 * taking its `'true'` or `'false'` edges. Input keys starting with `__cogitator:` are refused,
 * the run keeps its own bookkeeping under them. With `checkpoints` the job keeps one checkpoint,
 * saved after every node, so an attempt that comes after a failure (`willRetry`) goes on from it
 * instead of running its agents again, and the checkpoint goes once no attempt follows.
 */
export async function processWorkflowJob(
  payload: WorkflowJobPayload,
  runtime: WorkerRuntime = {},
  execution: JobExecutionOptions = {}
): Promise<WorkflowJobResult> {
  const started = Date.now();
  validateWorkflow(payload.workflowConfig);
  const reserved = Object.keys(payload.input).find((key) => key.startsWith(RUN_KEY));
  if (reserved !== undefined) {
    throw new Error(`Workflow input key '${reserved}' starts with '${RUN_KEY}', kept for the run`);
  }
  const resolved = resolveRuntime(runtime);
  const siblings = new AbortController();
  const workflow = workflowOf(payload.workflowConfig, resolved, siblings);
  const id = workflowCheckpointId(payload);
  const store = runtime.checkpoints && storeOfJob(runtime.checkpoints, id, siblings);
  const executor = new WorkflowExecutor(resolved.cogitator, store);
  const options = {
    workflowId: payload.runId,
    maxConcurrency: workflow.nodes.size,
    maxIterations: 2 * workflow.nodes.size + 2,
    ...(execution.signal && { signal: execution.signal }),
    ...(store && { checkpoint: true, checkpointStrategy: 'per-node' as const }),
  };

  try {
    const latest = store ? await store.load(id) : null;
    const result = latest
      ? await executor.resume(workflow, id, options)
      : await executor.execute(workflow, payload.input, options);
    if (result.error) throw result.error;
    execution.signal?.throwIfAborted();
    const nodeResults: Record<string, unknown> = {};
    for (const node of payload.workflowConfig.nodes) {
      nodeResults[node.id] =
        result.state[doneKey(node.id)] === true
          ? result.nodeResults.get(node.id)?.output
          : { skipped: true };
    }
    const done: WorkflowJobResult = {
      type: 'workflow',
      output: withoutRunKeys(result.state),
      nodeResults,
      usage: usageOf(result.state),
      duration: Date.now() - started,
    };
    await store?.delete(id).catch(() => undefined);
    return done;
  } catch (error) {
    if (!siblings.signal.aborted) siblings.abort(error);
    if (store && !execution.willRetry?.(error)) await store.delete(id).catch(() => undefined);
    throw error;
  }
}
