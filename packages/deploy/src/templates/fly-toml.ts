import type { DeployConfig } from '@cogitator-ai/types';

export function generateFlyToml(config: DeployConfig): string {
  const port = config.port ?? 3000;
  const region = config.region ?? 'iad';
  const app = config.image ?? 'cogitator-app';
  const memory = config.resources?.memory ?? '256mb';
  const memoryMb = parseInt(memory) || 256;

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
