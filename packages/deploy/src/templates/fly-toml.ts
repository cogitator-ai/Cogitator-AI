import type { DeployConfig } from '@cogitator-ai/types';

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

export function generateFlyToml(config: DeployConfig): string {
  const port = config.port ?? 3000;
  const region = config.region ?? 'iad';
  const app = config.image ?? 'cogitator-app';
  const memoryMb = parseMemoryMb(config.resources?.memory ?? '256mb');
  const instances = Math.max(config.instances ?? 1, 0);
  const healthPath = config.health?.path ?? '/health';

  const envEntries = Object.entries({ NODE_ENV: 'production', PORT: String(port), ...config.env });
  const envSection = envEntries.map(([key, value]) => `  ${key} = ${tomlString(value)}`).join('\n');

  return `app = ${tomlString(app)}
primary_region = ${tomlString(region)}

[build]

[env]
${envSection}

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = ${instances > 1 ? instances : 0}

[checks]
  [checks.health]
    port = ${port}
    type = "http"
    interval = ${tomlString(config.health?.interval ?? '30s')}
    timeout = ${tomlString(config.health?.timeout ?? '5s')}
    path = ${tomlString(healthPath.startsWith('/') ? healthPath : `/${healthPath}`)}

[[vm]]
  memory = "${memoryMb}mb"
  cpu_kind = "shared"
  cpus = ${config.resources?.cpu ?? 1}
`;
}
