export type DeployTarget = 'docker' | 'fly';

/** The Cogitator server adapter a project serves HTTP with. */
export type DeployServer = 'express' | 'fastify' | 'hono' | 'koa' | 'tetsu' | 'next';

/**
 * What a deployed project is:
 * - `server` answers HTTP on `port` and its health check path
 * - `worker` runs without serving HTTP (a channel gateway, a queue worker),
 *   gets no health check and publishes `port` only when one is set
 */
export type DeployKind = 'server' | 'worker';

/** A directory that outlives the container, such as the one a SQLite database lives in. */
export interface DeployVolume {
  /** Directory in the container, relative to the app directory or absolute */
  path: string;
  /** Volume name, derived from `path` when unset */
  name?: string;
  /** Size in GB of a Fly volume created for it, 1 by default */
  size?: number;
}

export interface DeployServicesConfig {
  redis?: boolean;
  postgres?: boolean;
  /**
   * An Ollama container next to the app, Docker target only. On by default when the
   * project's chat or embedding models run on a local Ollama, `false` reaches the
   * Ollama of the Docker host instead.
   */
  ollama?: boolean;
}

/** The Ollama container of the Docker target (`services.ollama`). */
export interface DeployOllamaConfig {
  /**
   * Models pulled on the first start, before the app starts. The local Ollama models of
   * the config (chat, memory stages, embeddings) when unset.
   */
  models?: string[];
  /** Reserve the host's NVIDIA GPUs for the container, which needs the NVIDIA Container Toolkit */
  gpu?: boolean;
  /** Ollama image, a pinned `ollama/ollama` release by default */
  image?: string;
}

export interface DeployHealthConfig {
  path?: string;
  interval?: string;
  timeout?: string;
}

export interface DeployResourcesConfig {
  memory?: string;
  cpu?: number;
}

export interface DeployConfig {
  target?: DeployTarget;
  /** Detected from the project's dependencies when unset */
  kind?: DeployKind;
  server?: DeployServer;
  port?: number;
  registry?: string;
  image?: string;
  /** Fly app name, `image` when unset. See `isFlyAppName` for the rules it follows. */
  app?: string;
  /** Fly organization slug `fly apps create` puts a new app in, the account's default when unset */
  org?: string;
  region?: string;
  instances?: number;
  services?: DeployServicesConfig;
  env?: Record<string, string>;
  secrets?: string[];
  health?: DeployHealthConfig;
  resources?: DeployResourcesConfig;
  /** Directories kept across deploys (Docker named volumes, Fly volumes) */
  volumes?: DeployVolume[];
  /**
   * Let the container reach services on the Docker host as `host.docker.internal`,
   * such as a local Ollama. Docker target only.
   */
  hostGateway?: boolean;
  /** The Ollama container of the Docker target */
  ollama?: DeployOllamaConfig;
}

const FLY_APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FLY_ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OLLAMA_MODEL_NAME = /^[A-Za-z0-9][\w.:/@+-]*$/;

/**
 * Whether `name` is a valid Fly.io app name: lowercase letters, digits and dashes,
 * starting and ending with a letter or digit, 63 characters at most, since the app
 * is served at `<name>.fly.dev`.
 */
export function isFlyAppName(name: string): boolean {
  return FLY_APP_NAME.test(name);
}

/** Whether `slug` looks like a Fly.io organization slug: lowercase letters, digits and dashes, starting with a letter or digit. */
export function isFlyOrgSlug(slug: string): boolean {
  return FLY_ORG_SLUG.test(slug);
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  fix?: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  passed: boolean;
}

export interface GeneratedArtifact {
  path: string;
  content: string;
}

export interface GeneratedArtifacts {
  files: GeneratedArtifact[];
  outputDir: string;
}

export interface DeployResult {
  success: boolean;
  url?: string;
  endpoints?: {
    api?: string;
    a2a?: string;
    health?: string;
  };
  error?: string;
}

export interface DeployStatus {
  running: boolean;
  url?: string;
  instances?: number;
  uptime?: string;
}

/**
 * Whether `name` can be handed to `ollama pull`: a model such as `llama3.2`, `qwen3:8b`
 * or `hf.co/user/repo:Q4_K_M`, starting with a letter or digit, so it never reads as a flag.
 */
export function isOllamaModelName(name: string): boolean {
  return OLLAMA_MODEL_NAME.test(name);
}
