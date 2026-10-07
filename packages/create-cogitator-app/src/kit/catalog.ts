import type {
  AppKind,
  ChannelKind,
  CodingAgent,
  DeployTarget,
  FeatureId,
  MemoryKind,
  ServerFramework,
  VectorStore,
} from './spec.js';

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint: string;
}

export const APP_CHOICES: Choice<AppKind>[] = [
  { value: 'script', label: 'Script', hint: 'an agent you run from the terminal' },
  { value: 'server', label: 'HTTP server', hint: 'agents behind a REST, SSE and WebSocket API' },
  { value: 'next', label: 'Next.js app', hint: 'a streaming chat UI with server-side agents' },
  { value: 'channels', label: 'Messaging bot', hint: 'Telegram, Discord, Slack or WebChat' },
  { value: 'worker', label: 'Queue worker', hint: 'agents run as BullMQ jobs on Redis' },
];

export const SERVER_CHOICES: Choice<ServerFramework>[] = [
  { value: 'hono', label: 'Hono', hint: 'small and fast, runs on Node' },
  { value: 'express', label: 'Express', hint: 'the classic, with Swagger UI' },
  { value: 'fastify', label: 'Fastify', hint: 'schema-first and fast' },
  { value: 'koa', label: 'Koa', hint: 'minimal middleware stack' },
  { value: 'tetsu', label: 'Tetsu', hint: 'Bun-native controller with OpenAPI, needs Bun' },
];

export const MEMORY_CHOICES: Choice<MemoryKind>[] = [
  { value: 'sqlite', label: 'SQLite', hint: 'a local file, no setup' },
  { value: 'memory', label: 'In-memory', hint: 'forgotten on restart' },
  { value: 'postgres', label: 'Postgres', hint: 'with pgvector, runs in Docker' },
  { value: 'redis', label: 'Redis', hint: 'runs in Docker' },
  { value: 'mongodb', label: 'MongoDB', hint: 'runs in Docker' },
  { value: 'none', label: 'None', hint: 'every run starts from scratch' },
];

export const VECTOR_STORE_CHOICES: Choice<VectorStore>[] = [
  { value: 'memory', label: 'In-memory', hint: 're-indexed on start' },
  { value: 'postgres', label: 'Postgres pgvector', hint: 'runs in Docker' },
  { value: 'qdrant', label: 'Qdrant', hint: 'runs in Docker' },
];

export const FEATURE_CHOICES: Choice<FeatureId>[] = [
  {
    value: 'harness',
    label: 'Assistant harness',
    hint: 'workspace file tools, approvals, core facts, scheduler',
  },
  { value: 'mcp', label: 'MCP', hint: 'tools from MCP servers, agents served over MCP' },
  { value: 'rag', label: 'RAG', hint: 'answers grounded in your docs/ folder' },
  { value: 'workflows', label: 'Workflows', hint: 'a multi-step DAG pipeline' },
  {
    value: 'durable',
    label: 'Durable workflows',
    hint: 'sagas, approvals, recovery after a crash',
  },
  { value: 'swarms', label: 'Swarms', hint: 'a team of agents with a supervisor' },
  { value: 'evals', label: 'Evals', hint: 'a dataset, metrics and `pnpm eval`' },
  { value: 'otel', label: 'OpenTelemetry', hint: 'traces to any OTLP collector' },
  { value: 'langfuse', label: 'Langfuse', hint: 'traces and costs in Langfuse' },
  { value: 'voice', label: 'Realtime voice', hint: 'a WebSocket voice agent' },
  { value: 'sandbox', label: 'Sandbox', hint: 'run code in Docker or WASM isolation' },
  { value: 'a2a', label: 'A2A', hint: 'expose agents over the Agent-to-Agent protocol' },
];

export const DEPLOY_CHOICES: Choice<DeployTarget>[] = [
  { value: 'docker', label: 'Docker', hint: 'a production Dockerfile and compose file' },
  { value: 'fly', label: 'Fly.io', hint: 'Dockerfile and fly.toml' },
  { value: 'none', label: 'None', hint: 'decide later with `cogitator deploy`' },
];

export const CHANNEL_CHOICES: Choice<ChannelKind>[] = [
  { value: 'webchat', label: 'WebChat', hint: 'a local WebSocket chat, no setup' },
  { value: 'telegram', label: 'Telegram', hint: 'needs a bot token from @BotFather' },
  { value: 'discord', label: 'Discord', hint: 'needs a bot token' },
  { value: 'slack', label: 'Slack', hint: 'needs a bot token and signing secret' },
];

export const CODING_AGENT_CHOICES: Choice<CodingAgent>[] = [
  { value: 'claude', label: 'Claude Code', hint: '.mcp.json and a skill in .claude/skills' },
  { value: 'cursor', label: 'Cursor', hint: '.cursor/mcp.json and a skill in .cursor/skills' },
  { value: 'codex', label: 'Codex', hint: '.codex/config.toml and a skill in .agents/skills' },
];

export function choiceLabel<T extends string>(choices: readonly Choice<T>[], value: T): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}
