import type { DeployConfig } from '@cogitator-ai/types';

function parseMemoryMb(memory: string): number {
  const gb = /^(\d+(?:\.\d+)?)\s*gb$/i.exec(memory);
  if (gb) return Math.round(parseFloat(gb[1]) * 1024);
  const mb = /^(\d+(?:\.\d+)?)\s*mb?$/i.exec(memory);
  if (mb) return Math.round(parseFloat(mb[1]));
  return parseInt(memory) || 256;
}

export function generateFlyToml(config: DeployConfig): string {
  const port = config.port ?? 3000;
  const region = config.region ?? 'iad';
  const app = config.image ?? 'cogitator-app';
  const memory = config.resources?.memory ?? '256mb';
  const memoryMb = parseMemoryMb(memory);

  return `app = "${app}"
primary_region = "${region}"

[build]

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[checks]
  [checks.health]
    port = ${port}
    type = "http"
    interval = "30s"
    timeout = "5s"
    path = "/health"

[[vm]]
  memory = "${memoryMb}mb"
  cpu_kind = "shared"
  cpus = ${config.resources?.cpu ?? 1}
`;
}
