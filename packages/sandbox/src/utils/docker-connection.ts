import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxDockerConfig } from '@cogitator-ai/types';

export type DockerConnectionOptions = { socketPath: string } | { host: string; port?: number };

export interface DockerConnectionEnv {
  env: Record<string, string | undefined>;
  home: string;
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
}

const defaultEnv = (): DockerConnectionEnv => ({
  env: process.env,
  home: homedir(),
  exists: existsSync,
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
});

/**
 * Where to reach the Docker daemon, in the order to try: the configured
 * socket or host; else what `DOCKER_HOST` says (`undefined`, Dockerode reads
 * it); else the endpoint of the Docker CLI's current context — as `docker`
 * itself does — followed by the sockets Docker Engine, Docker Desktop,
 * OrbStack, Colima, Rancher Desktop and rootless Docker listen on.
 */
export function dockerConnectionCandidates(
  config: SandboxDockerConfig = {},
  system: DockerConnectionEnv = defaultEnv()
): (DockerConnectionOptions | undefined)[] {
  if (config.socketPath) return [{ socketPath: config.socketPath }];
  if (config.host) return [{ host: config.host, port: config.port }];
  if (system.env.DOCKER_HOST) return [undefined];

  const candidates: DockerConnectionOptions[] = [];
  const context = currentContextEndpoint(system);
  if (context) candidates.push(context);

  const sockets = [
    '/var/run/docker.sock',
    join(system.home, '.docker/run/docker.sock'),
    join(system.home, '.orbstack/run/docker.sock'),
    join(system.home, '.colima/default/docker.sock'),
    join(system.home, '.colima/docker.sock'),
    join(system.home, '.rd/docker.sock'),
    ...(system.env.XDG_RUNTIME_DIR ? [join(system.env.XDG_RUNTIME_DIR, 'docker.sock')] : []),
  ];
  for (const socketPath of sockets) {
    const known = candidates.some((c) => 'socketPath' in c && c.socketPath === socketPath);
    if (!known && system.exists(socketPath)) candidates.push({ socketPath });
  }

  return candidates.length > 0 ? candidates : [undefined];
}

function currentContextEndpoint(system: DockerConnectionEnv): DockerConnectionOptions | undefined {
  const configDir = system.env.DOCKER_CONFIG ?? join(system.home, '.docker');
  const name = system.env.DOCKER_CONTEXT ?? readCurrentContext(system, configDir);
  if (!name || name === 'default') return undefined;

  const id = createHash('sha256').update(name).digest('hex');
  const meta = parseJson(system.readFile(join(configDir, 'contexts/meta', id, 'meta.json')));
  const host = endpointHost(meta);
  return host ? parseDockerHost(host) : undefined;
}

function readCurrentContext(system: DockerConnectionEnv, configDir: string): string | undefined {
  const config = parseJson(system.readFile(join(configDir, 'config.json')));
  const name = isRecord(config) ? config.currentContext : undefined;
  return typeof name === 'string' ? name : undefined;
}

function endpointHost(meta: unknown): string | undefined {
  if (!isRecord(meta) || !isRecord(meta.Endpoints)) return undefined;
  const docker = meta.Endpoints.docker;
  return isRecord(docker) && typeof docker.Host === 'string' ? docker.Host : undefined;
}

function parseDockerHost(host: string): DockerConnectionOptions | undefined {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  const tcp = /^tcp:\/\/([^:/]+)(?::(\d+))?/.exec(host);
  if (!tcp) return undefined;
  return { host: tcp[1], ...(tcp[2] && { port: Number(tcp[2]) }) };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
