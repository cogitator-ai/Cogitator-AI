/**
 * Workflow job processor
 *
 * Executes a serialized workflow graph as a DAG over a shared state object. Nodes run as
 * soon as all of their predecessors have settled; independent branches run concurrently.
 * Condition nodes activate their `'true'` or `'false'` outgoing edges; nodes reachable only
 * through inactive edges are skipped.
 */

import { z } from 'zod';
import type { LLMProvider } from '@cogitator-ai/types';
import type {
  ConditionNodeConfig,
  SerializedWorkflow,
  SerializedWorkflowNode,
  TransformNodeConfig,
  WorkerRuntime,
  WorkflowJobPayload,
  WorkflowJobResult,
} from '../types';
import { createAgentFromConfig, resolveCogitator } from './shared.js';

type WorkflowState = Record<string, unknown>;

const LLM_PROVIDERS = [
  'ollama',
  'openai',
  'anthropic',
  'google',
  'azure',
  'bedrock',
  'vllm',
  'mistral',
  'groq',
  'together',
  'deepseek',
] as const satisfies readonly LLMProvider[];

const serializedAgentSchema = z.object({
  name: z.string().min(1),
  instructions: z.string(),
  model: z.string().min(1),
  provider: z.enum(LLM_PROVIDERS),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.object({
        type: z.literal('object'),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).optional(),
      }),
    })
  ),
});

const agentNodeSchema = z.object({
  agentConfig: serializedAgentSchema,
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

type NodeOutcome =
  | { status: 'completed'; output: unknown; branch?: 'true' | 'false' }
  | { status: 'skipped' };

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
      case 'agent':
        parseNodeConfig(node, agentNodeSchema);
        break;
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

class WorkflowRun {
  private readonly nodes: Map<string, SerializedWorkflowNode>;
  private readonly outcomes = new Map<string, NodeOutcome>();
  private readonly outputKeys = new Map<string, string>();
  private readonly state: WorkflowState;

  constructor(
    private readonly workflow: SerializedWorkflow,
    input: Record<string, unknown>,
    private readonly runtime: WorkerRuntime
  ) {
    this.nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
    this.state = { ...input };
  }

  async execute(): Promise<{ state: WorkflowState; nodeResults: Record<string, unknown> }> {
    const pending = new Set(this.nodes.keys());
    const running = new Map<string, Promise<void>>();

    while (pending.size > 0 || running.size > 0) {
      for (const id of [...pending]) {
        const incoming = this.workflow.edges.filter((e) => e.to === id);
        if (!incoming.every((e) => this.outcomes.has(e.from))) continue;

        pending.delete(id);
        const active = incoming.length === 0 || incoming.some((e) => this.isEdgeActive(e));
        if (!active) {
          this.outcomes.set(id, { status: 'skipped' });
          continue;
        }

        running.set(
          id,
          this.runNode(this.nodes.get(id)!, incoming).then((outcome) => {
            this.outcomes.set(id, outcome);
            running.delete(id);
          })
        );
      }

      if (running.size > 0) {
        await Promise.race(running.values());
      } else if (pending.size > 0 && ![...pending].some((id) => this.isReady(id))) {
        throw new Error(`Workflow '${this.workflow.name}' cannot make progress`);
      }
    }

    const nodeResults: Record<string, unknown> = {};
    for (const [id, outcome] of this.outcomes) {
      nodeResults[id] = outcome.status === 'completed' ? outcome.output : { skipped: true };
    }
    return { state: this.state, nodeResults };
  }

  private isReady(id: string): boolean {
    return this.workflow.edges.filter((e) => e.to === id).every((e) => this.outcomes.has(e.from));
  }

  private isEdgeActive(edge: SerializedWorkflow['edges'][number]): boolean {
    const outcome = this.outcomes.get(edge.from);
    if (outcome?.status !== 'completed') return false;
    return outcome.branch === undefined || outcome.branch === edge.condition;
  }

  private previousOutput(incoming: SerializedWorkflow['edges']): unknown {
    for (const edge of incoming) {
      if (!this.isEdgeActive(edge)) continue;
      const key = this.outputKeys.get(edge.from);
      if (key !== undefined) return this.state[key];
    }
    return undefined;
  }

  private async runNode(
    node: SerializedWorkflowNode,
    incoming: SerializedWorkflow['edges']
  ): Promise<NodeOutcome> {
    switch (node.type) {
      case 'agent': {
        const config = parseNodeConfig(node, agentNodeSchema);
        const agent = createAgentFromConfig(config.agentConfig, this.runtime);
        const prompt = config.prompt
          ? renderTemplate(config.prompt, this.state)
          : JSON.stringify(this.state);
        const result = await resolveCogitator(this.runtime).run(agent, { input: prompt });
        return this.store(node.id, config.outputKey, result.output);
      }

      case 'transform': {
        const config: TransformNodeConfig = parseNodeConfig(node, transformNodeSchema);
        const input =
          config.inputKey !== undefined
            ? readStatePath(this.state, config.inputKey)
            : this.previousOutput(incoming);
        return this.store(node.id, config.outputKey, applyTransform(config, input, this.state));
      }

      case 'condition': {
        const config = parseNodeConfig(node, conditionNodeSchema);
        const passed = evaluateCondition(config, this.state);
        return { status: 'completed', output: passed, branch: passed ? 'true' : 'false' };
      }

      case 'parallel':
        return { status: 'completed', output: null };
    }
  }

  private store(nodeId: string, outputKey: string | undefined, value: unknown): NodeOutcome {
    const key = outputKey ?? nodeId;
    this.state[key] = value;
    this.outputKeys.set(nodeId, key);
    return { status: 'completed', output: value };
  }
}

export async function processWorkflowJob(
  payload: WorkflowJobPayload,
  runtime: WorkerRuntime = {}
): Promise<WorkflowJobResult> {
  const started = Date.now();
  validateWorkflow(payload.workflowConfig);

  const { state, nodeResults } = await new WorkflowRun(
    payload.workflowConfig,
    payload.input,
    runtime
  ).execute();

  return {
    type: 'workflow',
    output: state,
    nodeResults,
    duration: Date.now() - started,
  };
}
