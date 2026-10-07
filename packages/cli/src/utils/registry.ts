import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where a scaffolded project registers its agents, workflows and swarms. */
export const REGISTRY_PATH = 'src/cogitator.ts';

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: unknown;
  requiresApproval: boolean;
}

export interface AgentInfo {
  /** The key the registry exports it under. */
  key: string;
  name: string;
  description?: string;
  /** `provider/model`, absent when the agent takes the runtime's default model. */
  model?: string;
  instructions: string;
  tools: ToolInfo[];
}

export interface WorkflowInfo {
  key: string;
  name: string;
  entryPoint: string;
  nodes: string[];
  edges: Array<{ type: string; from: string; to: string[] }>;
}

export interface SwarmInfo {
  key: string;
  name: string;
  strategy: string;
  agents: string[];
}

export interface RegistryInfo {
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
  swarms: SwarmInfo[];
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

/** What the inspection child process sends back. */
export type InspectionMessage = { ok: true; registry: RegistryInfo } | { ok: false; error: string };

function workerEntry(): { path: string; execArgv: string[] } {
  const compiled = fileURLToPath(new URL('./registry-worker.js', import.meta.url));
  if (existsSync(compiled)) return { path: compiled, execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return {
    path: fileURLToPath(new URL('./registry-worker.ts', import.meta.url)),
    execArgv: ['--import', tsx],
  };
}

/**
 * Loads the registry of the project in `projectDir` in a child process and
 * describes it. A fresh process sees the code as it is now, keeps the
 * project's output and connections away from the caller, and is killed when
 * it takes longer than `timeoutMs`.
 */
export function inspectRegistry(projectDir: string, timeoutMs = 60_000): Promise<RegistryInfo> {
  if (!existsSync(join(projectDir, REGISTRY_PATH))) {
    return Promise.reject(
      new Error(
        `${REGISTRY_PATH} not found in ${projectDir}: projects from create-cogitator-app register their agents there`
      )
    );
  }
  const entry = workerEntry();
  return new Promise((resolve, reject) => {
    const child = fork(entry.path, [projectDir], {
      cwd: projectDir,
      execArgv: entry.execArgv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`Loading ${REGISTRY_PATH} took longer than ${timeoutMs} ms`)));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('message', (message: InspectionMessage) => {
      settle(() => (message.ok ? resolve(message.registry) : reject(new Error(message.error))));
    });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code) => {
      settle(() =>
        reject(
          new Error(
            `Loading ${REGISTRY_PATH} failed (exit ${code ?? 'signal'})${stderr ? `:\n${stderr.trim().split('\n').slice(-20).join('\n')}` : ''}`
          )
        )
      );
    });
  });
}
