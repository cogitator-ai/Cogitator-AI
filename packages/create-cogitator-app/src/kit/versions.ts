declare const __COGITATOR_VERSIONS__: Record<string, string> | undefined;
declare const __SCAFFOLDER_VERSION__: string | undefined;

/** The version of create-cogitator-app itself, inlined at build time. */
export function scaffolderVersion(): string {
  return typeof __SCAFFOLDER_VERSION__ === 'undefined' ? '0.0.0' : __SCAFFOLDER_VERSION__;
}

/**
 * The versions of the `@cogitator-ai/*` packages, inlined when the scaffolder is
 * built (and when its tests run) from the workspace it is released from.
 */
function workspaceVersions(): Record<string, string> {
  return typeof __COGITATOR_VERSIONS__ === 'undefined' ? {} : __COGITATOR_VERSIONS__;
}

export type CogitatorPackage = `@cogitator-ai/${string}`;

/** The range a generated project depends on for `name`: a caret on the version released with the scaffolder. */
export function cogitatorVersion(name: CogitatorPackage): string {
  const version = workspaceVersions()[name];
  if (!version) {
    throw new Error(`${name} is not a published @cogitator-ai package, so its version is unknown`);
  }
  return `^${version}`;
}

/** Every `@cogitator-ai/*` version the scaffolder knows, for `--json` and diagnostics. */
export function knownCogitatorVersions(): Record<string, string> {
  return { ...workspaceVersions() };
}

/**
 * Third-party packages generated projects depend on, in one place so every
 * feature asks for the same range. Ranges follow the current majors.
 */
export const VERSIONS = {
  zod: '^4.6.5',
  typescript: '^7.0.2',
  typesNode: '^24.19.1',
  tsx: '^4.23.15',
  vitest: '^5.0.3',
  biome: '^2.5.15',
  express: '^5.2.1',
  typesExpress: '^5.0.6',
  fastify: '^5.12.5',
  fastifyCors: '^11.3.0',
  hono: '^4.13.13',
  honoNodeServer: '^2.1.3',
  koa: '^3.2.1',
  koaRouter: '^15.7.0',
  typesKoa: '^3.0.3',
  typesKoaRouter: '^15.0.0',
  koaCors: '^5.0.0',
  typesKoaCors: '^5.0.1',
  koaBodyparser: '^6.1.0',
  tetsuCore: '^0.6.3',
  tetsuSse: '^0.6.3',
  tetsuOpenapi: '^0.6.3',
  typesBun: '^1.4.2',
  next: '^16.4.0',
  react: '^19.3.0',
  reactDom: '^19.3.0',
  typesReact: '^19.3.0',
  typesReactDom: '^19.3.0',
  tailwind: '^4.3.3',
  tailwindPostcss: '^4.3.3',
  reactMarkdown: '^10.1.0',
  betterSqlite3: '^13.0.3',
  pg: '^8.23.1',
  ioredis: '^6.0.0',
  mongodb: '^7.7.0',
  qdrant: '^1.19.0',
  grammy: '^1.46.0',
  discord: '^14.27.0',
  slackBolt: '^5.1.0',
  ws: '^8.22.0',
  atprotoApi: '^0.24.0',
  langfuse: '^3.39.2',
  modelContextProtocol: '^1.32.1',
} as const;

/** Container images compose and deploy use, pinned so a project starts the same way every time. */
export const IMAGES = {
  redis: 'redis:8.8-alpine',
  postgres: 'pgvector/pgvector:0.8.7-pg18-trixie',
  mongodb: 'mongo:8.3',
  qdrant: 'qdrant/qdrant:v1.19.2',
  ollama: 'ollama/ollama:0.40.0',
  jaeger: 'jaegertracing/jaeger:2.22.0',
} as const;

/** The Node.js versions generated projects support: `--env-file-if-exists` needs 22.9+. */
export const NODE_ENGINES = '>=22.12.0';

/** The Bun version Tetsu servers need. */
export const BUN_ENGINES = '>=1.4.0';
