import { z } from 'zod';

export const PROVIDERS = ['ollama', 'openai', 'anthropic', 'google'] as const;
export const APP_KINDS = ['script', 'server', 'next', 'channels', 'worker'] as const;
export const SERVERS = ['express', 'fastify', 'hono', 'koa', 'tetsu'] as const;
export const MEMORIES = ['none', 'memory', 'sqlite', 'postgres', 'redis', 'mongodb'] as const;
export const VECTOR_STORES = ['memory', 'postgres', 'qdrant'] as const;
export const FEATURES = [
  'harness',
  'mcp',
  'rag',
  'workflows',
  'durable',
  'swarms',
  'evals',
  'otel',
  'langfuse',
  'voice',
  'sandbox',
  'a2a',
] as const;
export const DEPLOY_TARGETS = ['none', 'docker', 'fly'] as const;
export const CODING_AGENTS = ['claude', 'cursor', 'codex'] as const;
export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;
export const CHANNELS = ['telegram', 'discord', 'slack', 'webchat'] as const;

export type LLMProvider = (typeof PROVIDERS)[number];
export type AppKind = (typeof APP_KINDS)[number];
export type ServerFramework = (typeof SERVERS)[number];
export type MemoryKind = (typeof MEMORIES)[number];
export type VectorStore = (typeof VECTOR_STORES)[number];
export type FeatureId = (typeof FEATURES)[number];
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];
export type CodingAgent = (typeof CODING_AGENTS)[number];
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];
export type ChannelKind = (typeof CHANNELS)[number];

const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 214;

/**
 * Why `name` cannot be the generated package's name, or `undefined` when it can.
 * The name lands in package.json and in generated code, so it has to be a valid
 * unscoped npm package name.
 */
export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Project name is required';
  if (trimmed.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters`;
  if (!PACKAGE_NAME.test(trimmed)) {
    return 'Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit';
  }
  return undefined;
}

const ProjectNameSchema = z.string().superRefine((value, ctx) => {
  const error = validateProjectName(value);
  if (error) ctx.addIssue({ code: 'custom', message: error });
});

/**
 * Everything that decides what a generated project contains. A spec is plain data:
 * it is stored in the project's package.json (`cogitator.spec`) so the project can
 * be regenerated and extended with `cogitator add`, and it never holds secrets.
 */
export const ProjectSpecSchema = z
  .object({
    name: ProjectNameSchema,
    preset: z.string().min(1).optional(),
    app: z.enum(APP_KINDS),
    server: z.enum(SERVERS).optional(),
    channels: z.array(z.enum(CHANNELS)).default([]),
    memory: z.enum(MEMORIES),
    vectorStore: z.enum(VECTOR_STORES).default('memory'),
    features: z.array(z.enum(FEATURES)).default([]),
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1),
    deploy: z.enum(DEPLOY_TARGETS).default('none'),
    compose: z.boolean().default(true),
    packageManager: z.enum(PACKAGE_MANAGERS),
    codingAgents: z.array(z.enum(CODING_AGENTS)).default([]),
  })
  .strict();

export type ProjectSpec = z.output<typeof ProjectSpecSchema>;
export type ProjectSpecInput = z.input<typeof ProjectSpecSchema>;

/** `items` without duplicates, in the canonical order of `order`. */
export function canonical<T extends string>(items: readonly T[], order: readonly T[]): T[] {
  const set = new Set(items);
  return order.filter((item) => set.has(item));
}

/**
 * Parses and normalizes a spec: lists are deduplicated and sorted the way the
 * catalogs list them, so two specs that mean the same project are equal.
 */
export function parseSpec(input: unknown): ProjectSpec {
  const spec = ProjectSpecSchema.parse(input);
  return {
    ...spec,
    channels: canonical(spec.channels, CHANNELS),
    features: canonical(spec.features, FEATURES),
    codingAgents: canonical(spec.codingAgents, CODING_AGENTS),
  };
}

export function hasFeature(spec: Pick<ProjectSpec, 'features'>, feature: FeatureId): boolean {
  return spec.features.includes(feature);
}

/** The model as the runtime addresses it: `provider/model`. */
export function qualifiedModel(spec: Pick<ProjectSpec, 'provider' | 'model'>): string {
  const prefix = `${spec.provider}/`;
  return spec.model.startsWith(prefix) ? spec.model : `${prefix}${spec.model}`;
}

/** The model without the provider prefix, as provider APIs and `ollama pull` name it. */
export function bareModel(spec: Pick<ProjectSpec, 'provider' | 'model'>): string {
  const prefix = `${spec.provider}/`;
  return spec.model.startsWith(prefix) ? spec.model.slice(prefix.length) : spec.model;
}

/** What `start` runs in a script project: the assistant, the workflow, the swarm or the voice server. */
export type PrimaryTarget = 'agent' | 'workflow' | 'swarm' | 'voice';

export function primaryTarget(spec: Pick<ProjectSpec, 'features'>): PrimaryTarget {
  if (hasFeature(spec, 'voice')) return 'voice';
  if (hasFeature(spec, 'workflows')) return 'workflow';
  if (hasFeature(spec, 'swarms')) return 'swarm';
  return 'agent';
}

/** Whether the project runs on Bun instead of Node. */
export function runsOnBun(spec: Pick<ProjectSpec, 'server'>): boolean {
  return spec.server === 'tetsu';
}
