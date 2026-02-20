export type DeployTarget = 'docker' | 'fly' | 'railway' | 'k8s' | 'ssh';

export type DeployServer = 'express' | 'fastify' | 'hono' | 'koa';

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
