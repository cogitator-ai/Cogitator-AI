import type { DeployConfig } from '@cogitator-ai/types';
import { PROVIDER_ENV, providerEnvNames } from '@cogitator-ai/config';
import { volumeMountPath, volumeName } from '../volumes.js';
import { servesHttp } from './health.js';
import { trimTrailing } from '../utils/text.js';

export const COMPOSE_DATABASE_URL = 'postgresql://cogitator:cogitator@postgres:5432/cogitator';
export const COMPOSE_REDIS_URL = 'redis://redis:6379';
export const COMPOSE_OLLAMA_URL = 'http://ollama:11434';
/** The Ollama release the `ollama` service runs unless `ollama.image` names another. */
export const OLLAMA_IMAGE = 'ollama/ollama:0.40.0';

/**
 * Pulls each model it gets as an argument unless the volume has it already, so a
 * restart without network still starts. The models are arguments, never part of
 * the script, and `$$` is a literal `$` for docker compose.
 */
const OLLAMA_PULL_SCRIPT =
  'for model in "$$@"; do ollama show "$$model" > /dev/null 2>&1 || ollama pull "$$model" || exit 1; done';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** `value` with `$` doubled, so docker compose keeps it instead of interpolating a variable. */
function composeLiteral(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

function yamlList(items: readonly string[]): string {
  return `[${items.map(yamlString).join(', ')}]`;
}

/** Variables the app reads the Ollama URL from, every name `loadConfig` and the Ollama SDK look at. */
function ollamaUrlEnvNames(): string[] {
  return PROVIDER_ENV.ollama
    .filter((setting) => setting.field === 'baseUrl')
    .flatMap((setting) => providerEnvNames(setting));
}

/** The models the `ollama` service pulls before the app starts, undefined when the deployment runs no Ollama. */
function ollamaModels(config: DeployConfig): string[] | undefined {
  return config.services?.ollama ? [...new Set(config.ollama?.models ?? [])] : undefined;
}

function ollamaServices(config: DeployConfig, models: readonly string[]): string[] {
  const image = yamlString(config.ollama?.image ?? OLLAMA_IMAGE);
  const lines = [
    '',
    '  ollama:',
    `    image: ${image}`,
    '    restart: unless-stopped',
    '    volumes:',
    '      - ollama-data:/root/.ollama',
    '    healthcheck:',
    '      test: ["CMD", "ollama", "list"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 20',
  ];
  if (config.ollama?.gpu) {
    lines.push(
      '    deploy:',
      '      resources:',
      '        reservations:',
      '          devices:',
      '            - driver: nvidia',
      '              count: all',
      '              capabilities: [gpu]'
    );
  }
  if (models.length > 0) {
    lines.push(
      '',
      '  ollama-pull:',
      `    image: ${image}`,
      '    environment:',
      `      OLLAMA_HOST: ${yamlString(COMPOSE_OLLAMA_URL)}`,
      `    entrypoint: ${yamlList(['/bin/sh', '-c', OLLAMA_PULL_SCRIPT, 'ollama-pull'])}`,
      `    command: ${yamlList(models.map(composeLiteral))}`,
      '    depends_on:',
      '      ollama:',
      '        condition: service_healthy',
      '    restart: "no"'
    );
  }
  return lines;
}

export function imageTag(config: DeployConfig): string {
  const image = config.image ?? 'cogitator-app';
  return config.registry
    ? `${trimTrailing(config.registry, '/')}/${image}:latest`
    : `${image}:latest`;
}

export function generateDockerCompose(config: DeployConfig): string {
  const http = servesHttp(config);
  const port = config.port ?? 3000;
  const lines: string[] = ['services:'];

  const models = ollamaModels(config);

  const serviceUrls = new Map<string, string>();
  if (config.services?.redis) serviceUrls.set('REDIS_URL', COMPOSE_REDIS_URL);
  if (config.services?.postgres) serviceUrls.set('DATABASE_URL', COMPOSE_DATABASE_URL);
  if (models) {
    const names = ollamaUrlEnvNames();
    const explicit = names.some(
      (name) => name in (config.env ?? {}) || (config.secrets ?? []).includes(name)
    );
    if (!explicit) for (const name of names) serviceUrls.set(name, COMPOSE_OLLAMA_URL);
  }

  const environment = new Map<string, string>([['NODE_ENV', yamlString('production')]]);
  if (http) environment.set('PORT', yamlString(String(port)));
  for (const [key, url] of serviceUrls) environment.set(key, yamlString(url));
  for (const [key, value] of Object.entries(config.env ?? {})) {
    environment.set(key, yamlString(composeLiteral(value)));
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
  if (models) {
    dependsOn.push('      ollama:', '        condition: service_healthy');
    if (models.length > 0) {
      dependsOn.push('      ollama-pull:', '        condition: service_completed_successfully');
    }
  }

  const appVolumes = (config.volumes ?? []).map(
    (volume) => `      - ${volumeName(volume)}:${volumeMountPath(volume)}`
  );

  lines.push('  app:');
  lines.push('    build:');
  lines.push('      context: ..');
  lines.push('      dockerfile: .cogitator/Dockerfile');
  lines.push(`    image: ${yamlString(imageTag(config))}`);
  if (http) {
    lines.push('    ports:');
    lines.push(`      - "${port}:${port}"`);
  }
  if (config.hostGateway) {
    lines.push('    extra_hosts:');
    lines.push('      - "host.docker.internal:host-gateway"');
  }
  lines.push('    environment:');
  for (const [key, value] of environment) lines.push(`      ${key}: ${value}`);
  if (appVolumes.length > 0) {
    lines.push('    volumes:');
    lines.push(...appVolumes);
  }
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

  if (models) lines.push(...ollamaServices(config, models));

  const volumes = (config.volumes ?? []).map((volume) => `  ${volumeName(volume)}:`);
  if (config.services?.redis) volumes.push('  redis-data:');
  if (config.services?.postgres) volumes.push('  postgres-data:');
  if (models) volumes.push('  ollama-data:');

  if (volumes.length > 0) {
    lines.push('');
    lines.push('volumes:');
    lines.push(...new Set(volumes));
  }

  return lines.join('\n') + '\n';
}
