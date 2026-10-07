import type { ProjectSpecInput } from './spec.js';

/** The parts of a spec a preset fixes: everything except the name, provider and tooling. */
export type PresetSpec = Pick<
  ProjectSpecInput,
  'app' | 'server' | 'channels' | 'memory' | 'vectorStore' | 'features'
> & { provider?: ProjectSpecInput['provider'] };

export interface Preset {
  id: string;
  label: string;
  hint: string;
  spec: PresetSpec;
  /** Earlier names of the preset that `--template` still accepts. */
  aliases?: string[];
}

/**
 * Named starting points. Every preset is a combination of the stack axes, so a
 * preset project can grow with `cogitator add` like any other.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'basic',
    label: 'Basic agent',
    hint: 'one agent with real tools in your terminal, the best place to start',
    spec: { app: 'script', memory: 'none', features: [] },
  },
  {
    id: 'assistant',
    label: 'Personal assistant',
    hint: 'workspace files with approvals, long-term memory, a scheduler and evals',
    spec: { app: 'script', memory: 'sqlite', features: ['harness', 'evals'] },
  },
  {
    id: 'memory',
    label: 'Agent with memory',
    hint: 'conversations that survive restarts, in SQLite',
    spec: { app: 'script', memory: 'sqlite', features: [] },
  },
  {
    id: 'api-server',
    label: 'REST API server',
    hint: 'Express with Swagger UI, token auth and persistent threads',
    spec: { app: 'server', server: 'express', memory: 'sqlite', features: [] },
  },
  {
    id: 'hono',
    label: 'Hono server',
    hint: 'agents behind a small, fast HTTP API',
    spec: { app: 'server', server: 'hono', memory: 'sqlite', features: [] },
  },
  {
    id: 'tetsu',
    label: 'Tetsu server on Bun',
    hint: 'Bun-native controller with OpenAPI and WebSocket',
    spec: { app: 'server', server: 'tetsu', memory: 'memory', features: [] },
  },
  {
    id: 'nextjs',
    label: 'Next.js chat app',
    hint: 'streaming chat with tool calls, approvals and saved threads',
    spec: { app: 'next', memory: 'sqlite', features: [] },
  },
  {
    id: 'channels',
    label: 'Messaging bot',
    hint: 'one assistant on Telegram, Discord, Slack or WebChat',
    spec: { app: 'channels', channels: ['webchat'], memory: 'sqlite', features: [] },
  },
  {
    id: 'rag',
    label: 'RAG over your docs',
    hint: 'answers grounded in the files of docs/',
    spec: { app: 'script', memory: 'none', vectorStore: 'memory', features: ['rag'] },
  },
  {
    id: 'mcp',
    label: 'MCP tools and server',
    hint: 'tools from an MCP server, your agents served over MCP',
    spec: { app: 'script', memory: 'none', features: ['mcp'] },
  },
  {
    id: 'swarm',
    label: 'Multi-agent swarm',
    hint: 'a researcher and a writer under a reviewing supervisor',
    spec: { app: 'script', memory: 'none', features: ['swarms'] },
  },
  {
    id: 'workflow',
    label: 'DAG workflow',
    hint: 'a multi-step pipeline of agents',
    spec: { app: 'script', memory: 'none', features: ['workflows'] },
  },
  {
    id: 'durable-workflow',
    label: 'Durable workflow',
    hint: 'a saga with compensation, an approval step and crash recovery',
    spec: { app: 'script', memory: 'none', features: ['workflows', 'durable'] },
  },
  {
    id: 'a2a',
    label: 'A2A agent',
    hint: 'an agent other frameworks call over the Agent-to-Agent protocol',
    spec: { app: 'server', server: 'hono', memory: 'memory', features: ['a2a'] },
  },
  {
    id: 'voice-realtime',
    label: 'Realtime voice agent',
    hint: 'speech in, speech out over WebSocket',
    spec: { app: 'script', memory: 'none', features: ['voice'], provider: 'openai' },
  },
  {
    id: 'evals',
    label: 'Evals',
    hint: 'measure an agent on a dataset and gate CI on the score',
    spec: { app: 'script', memory: 'none', features: ['evals'] },
  },
];

export const DEFAULT_PRESET = 'basic';

export function findPreset(idOrAlias: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === idOrAlias || preset.aliases?.includes(idOrAlias));
}

export function presetIds(): string[] {
  return PRESETS.map((preset) => preset.id);
}
