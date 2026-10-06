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
