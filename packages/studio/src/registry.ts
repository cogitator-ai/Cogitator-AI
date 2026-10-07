import type { AgentInfo, RegistryInfo, SwarmInfo, ToolInfo, WorkflowInfo } from './protocol.js';

/** Where a scaffolded project registers its agents, workflows and swarms. */
export const REGISTRY_PATH = 'src/cogitator.ts';

/** `value` as plain JSON, `null` for what JSON cannot hold. */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return null;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The agent behind a value, judged by shape: the project and the CLI may load
 * different copies of @cogitator-ai/core, so `instanceof Agent` cannot be used.
 */
function agentShape(value: unknown): { config: UnknownRecord; tools: unknown[] } | undefined {
  if (!isRecord(value) || !isRecord(value.config)) return undefined;
  if (typeof value.config.name !== 'string' || typeof value.config.instructions !== 'string') {
    return undefined;
  }
  return { config: value.config, tools: Array.isArray(value.tools) ? value.tools : [] };
}

function describeTool(value: unknown): ToolInfo | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined;
  const schema = typeof value.toJSON === 'function' ? (value.toJSON as () => unknown)() : undefined;
  return {
    name: value.name,
    description: stringOf(value.description) ?? '',
    parameters: isRecord(schema) ? schema.parameters : undefined,
    requiresApproval: value.requiresApproval !== undefined && value.requiresApproval !== false,
  };
}

function describeAgent(key: string, value: unknown): AgentInfo | undefined {
  const agent = agentShape(value);
  if (!agent) return undefined;
  const { config } = agent;
  return {
    key,
    name: String(config.name),
    ...(stringOf(config.description) && { description: stringOf(config.description) }),
    ...(stringOf(config.model) && { model: stringOf(config.model) }),
    instructions: String(config.instructions),
    tools: agent.tools.map(describeTool).filter((tool): tool is ToolInfo => tool !== undefined),
  };
}

function describeWorkflow(key: string, value: unknown): WorkflowInfo | undefined {
  if (!isRecord(value) || !(value.nodes instanceof Map) || typeof value.entryPoint !== 'string') {
    return undefined;
  }
  const edges = Array.isArray(value.edges) ? value.edges.filter(isRecord) : [];
  return {
    key,
    name: stringOf(value.name) ?? key,
    entryPoint: value.entryPoint,
    initialState: jsonSafe(value.initialState),
    nodes: [...value.nodes.keys()].map(String),
    edges: edges.map((edge) => {
      const targets = [edge.to, edge.targets, edge.back, edge.exit].flatMap((target) =>
        Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : []
      );
      return { type: stringOf(edge.type) ?? 'sequential', from: String(edge.from), to: targets };
    }),
  };
}

function describeSwarm(key: string, value: unknown): SwarmInfo | undefined {
  if (!isRecord(value) || typeof value.strategy !== 'string') return undefined;
  const names = new Set<string>();
  const add = (candidate: unknown) => {
    const agent = agentShape(candidate);
    if (agent) names.add(String(agent.config.name));
  };
  for (const field of ['supervisor', 'moderator', 'router']) add(value[field]);
  for (const field of ['workers', 'agents']) {
    const list = value[field];
    if (Array.isArray(list)) list.forEach(add);
  }
  if (Array.isArray(value.stages)) {
    for (const stage of value.stages) if (isRecord(stage)) add(stage.agent);
  }
  return { key, name: stringOf(value.name) ?? key, strategy: value.strategy, agents: [...names] };
}

function describeGroup<T>(
  group: unknown,
  describe: (key: string, value: unknown) => T | undefined
): T[] {
  if (!isRecord(group)) return [];
  return Object.entries(group)
    .map(([key, value]) => describe(key, value))
    .filter((item): item is T => item !== undefined);
}

/** The agents, workflows and swarms a registry module exports, as plain data. */
export function describeRegistry(module: UnknownRecord): RegistryInfo {
  return {
    agents: describeGroup(module.agents, describeAgent),
    workflows: describeGroup(module.workflows, describeWorkflow),
    swarms: describeGroup(module.swarms, describeSwarm),
  };
}
