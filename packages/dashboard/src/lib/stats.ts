/**
 * Facts about the codebase shown on the landing page and in structured data.
 * Each list mirrors the source it is counted from; update it together with that source.
 */

/** `KNOWN_PROVIDERS` in `packages/core/src/llm/providers.ts`. */
export const LLM_PROVIDERS = [
  'Ollama',
  'OpenAI',
  'Anthropic',
  'Google',
  'Azure OpenAI',
  'AWS Bedrock',
  'vLLM',
  'Mistral',
  'Groq',
  'Together',
  'DeepSeek',
] as const;

/** Adapters in `packages/memory/src/adapters` (`createMemoryAdapter` plus the Qdrant embedding adapter). */
export const MEMORY_BACKENDS = [
  'In-memory',
  'Redis',
  'Postgres',
  'SQLite',
  'MongoDB',
  'Qdrant',
] as const;

/** `createStrategy` cases in `packages/swarms/src/strategies/index.ts`. */
export const SWARM_STRATEGIES = [
  'hierarchical',
  'round-robin',
  'consensus',
  'auction',
  'pipeline',
  'debate',
  'negotiation',
] as const;

/** Messaging platforms in `packages/channels/src/channels`; the local terminal channel is not counted. */
export const CHANNELS = ['Telegram', 'Discord', 'Slack', 'WhatsApp', 'WebChat'] as const;

/** Length of `builtinTools` in `packages/core/src/tools/index.ts`. */
export const BUILTIN_TOOL_COUNT = 26;

/** Packages under `packages/` whose `package.json` is not `"private": true`. */
export const NPM_PACKAGE_COUNT = 33;

/** Runnable examples under `examples/`, counted per category like the root README. */
export const EXAMPLE_COUNT = 74;
