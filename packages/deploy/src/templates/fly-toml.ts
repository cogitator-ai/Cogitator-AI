import type { DeployConfig } from '@cogitator-ai/types';
import { volumeMountPath, volumeName } from '../volumes.js';
import { healthPath, servesHttp } from './health.js';

export function parseMemoryMb(memory: string): number {
  const gb = /^(\d+(?:\.\d+)?)\s*gb?$/i.exec(memory.trim());
  if (gb) return Math.round(parseFloat(gb[1]) * 1024);
  const mb = /^(\d+(?:\.\d+)?)\s*mb?$/i.exec(memory.trim());
  if (mb) return Math.round(parseFloat(mb[1]));
  return 256;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The HTTP service of a deployment. A server stops when idle and starts on
 * the next request. A worker keeps running: it serves its port, if any, but
 * the Fly proxy must never stop it, since it works without requests coming in.
 */
function httpService(config: DeployConfig, port: number, instances: number): string[] {
  const worker = config.kind === 'worker';
  return [
    '[http_service]',
    `  internal_port = ${port}`,
    '  force_https = true',
    `  auto_stop_machines = ${tomlString(worker ? 'off' : 'stop')}`,
    '  auto_start_machines = true',
    `  min_machines_running = ${worker ? Math.max(instances, 1) : instances > 1 ? instances : 0}`,
    '',
  ];
}

function healthChecks(config: DeployConfig, port: number, path: string): string[] {
  return [
    '[checks]',
    '  [checks.health]',
    `    port = ${port}`,
    '    type = "http"',
    `    interval = ${tomlString(config.health?.interval ?? '30s')}`,
    `    timeout = ${tomlString(config.health?.timeout ?? '5s')}`,
    `    path = ${tomlString(path)}`,
    '',
  ];
}

export function generateFlyToml(config: DeployConfig): string {
  const http = servesHttp(config);
  const port = config.port ?? 3000;
  const region = config.region ?? 'iad';
  const app = config.image ?? 'cogitator-app';
  const memoryMb = parseMemoryMb(config.resources?.memory ?? '256mb');
  const instances = Math.max(config.instances ?? 1, 0);
  const path = http ? healthPath(config) : undefined;

  const envEntries = Object.entries({
    NODE_ENV: 'production',
    ...(http ? { PORT: String(port) } : {}),
    ...config.env,
  });
  const volume = config.volumes?.[0];

  return [
    `app = ${tomlString(app)}`,
    `primary_region = ${tomlString(region)}`,
    '',
    '[build]',
    '',
    '[env]',
    ...envEntries.map(([key, value]) => `  ${key} = ${tomlString(value)}`),
    '',
    ...(volume
      ? [
          '[mounts]',
          `  source = ${tomlString(volumeName(volume))}`,
          `  destination = ${tomlString(volumeMountPath(volume))}`,
          `  initial_size = "${volume.size ?? 1}gb"`,
          '',
        ]
      : []),
    ...(http ? httpService(config, port, instances) : []),
    ...(path ? healthChecks(config, port, path) : []),
    '[[vm]]',
    `  memory = "${memoryMb}mb"`,
    '  cpu_kind = "shared"',
    `  cpus = ${config.resources?.cpu ?? 1}`,
    '',
  ].join('\n');
}
