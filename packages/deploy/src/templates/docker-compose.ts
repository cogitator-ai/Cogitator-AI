import type { DeployConfig } from '@cogitator-ai/types';

export const COMPOSE_DATABASE_URL = 'postgresql://cogitator:cogitator@postgres:5432/cogitator';
export const COMPOSE_REDIS_URL = 'redis://redis:6379';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export function imageTag(config: DeployConfig): string {
  const image = config.image ?? 'cogitator-app';
  return config.registry
    ? `${stripTrailingSlashes(config.registry)}/${image}:latest`
    : `${image}:latest`;
}

export function generateDockerCompose(config: DeployConfig): string {
  const port = config.port ?? 3000;
  const lines: string[] = ['services:'];

  const serviceUrls = new Map<string, string>();
  if (config.services?.redis) serviceUrls.set('REDIS_URL', COMPOSE_REDIS_URL);
  if (config.services?.postgres) serviceUrls.set('DATABASE_URL', COMPOSE_DATABASE_URL);

  const environment = new Map<string, string>([
    ['NODE_ENV', yamlString('production')],
    ['PORT', yamlString(String(port))],
  ]);
  for (const [key, url] of serviceUrls) environment.set(key, yamlString(url));
  for (const [key, value] of Object.entries(config.env ?? {})) {
    environment.set(key, yamlString(value.replace(/\$/g, '$$$$')));
  }
  for (const secret of config.secrets ?? []) {
    if (!(secret in (config.env ?? {}))) {
      environment.set(secret, `\${${secret}:-${serviceUrls.get(secret) ?? ''}}`);
    }
  }

  const dependsOn: string[] = [];
  if (config.services?.redis) dependsOn.push('      redis:', '        condition: service_healthy');
  if (config.services?.postgres) {
    dependsOn.push('      postgres:', '        condition: service_healthy');
  }

  lines.push('  app:');
  lines.push('    build:');
  lines.push('      context: ..');
  lines.push('      dockerfile: .cogitator/Dockerfile');
  lines.push(`    image: ${yamlString(imageTag(config))}`);
  lines.push('    ports:');
  lines.push(`      - "${port}:${port}"`);
  lines.push('    environment:');
  for (const [key, value] of environment) lines.push(`      ${key}: ${value}`);
  lines.push('    restart: unless-stopped');
  if (dependsOn.length > 0) {
    lines.push('    depends_on:');
    lines.push(...dependsOn);
  }

  if (config.services?.redis) {
    lines.push('');
    lines.push('  redis:');
    lines.push('    image: redis:7-alpine');
    lines.push('    restart: unless-stopped');
    lines.push('    volumes:');
    lines.push('      - redis-data:/data');
    lines.push('    healthcheck:');
    lines.push('      test: ["CMD", "redis-cli", "ping"]');
    lines.push('      interval: 10s');
    lines.push('      timeout: 3s');
    lines.push('      retries: 3');
  }

  if (config.services?.postgres) {
    lines.push('');
    lines.push('  postgres:');
    lines.push('    image: pgvector/pgvector:pg16');
    lines.push('    restart: unless-stopped');
    lines.push('    environment:');
    lines.push('      POSTGRES_USER: cogitator');
    lines.push('      POSTGRES_PASSWORD: cogitator');
    lines.push('      POSTGRES_DB: cogitator');
    lines.push('    volumes:');
    lines.push('      - postgres-data:/var/lib/postgresql/data');
    lines.push('    healthcheck:');
    lines.push('      test: ["CMD-SHELL", "pg_isready -U cogitator"]');
    lines.push('      interval: 10s');
    lines.push('      timeout: 3s');
    lines.push('      retries: 3');
  }

  const volumes: string[] = [];
  if (config.services?.redis) volumes.push('  redis-data:');
  if (config.services?.postgres) volumes.push('  postgres-data:');

  if (volumes.length > 0) {
    lines.push('');
    lines.push('volumes:');
    lines.push(...volumes);
  }

  return lines.join('\n') + '\n';
}
