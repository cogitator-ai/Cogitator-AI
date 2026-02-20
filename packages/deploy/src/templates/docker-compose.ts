import type { DeployConfig } from '@cogitator-ai/types';

export function generateDockerCompose(config: DeployConfig): string {
  const port = config.port ?? 3000;
  const image = config.image ?? 'cogitator-app';
  const lines: string[] = ['services:'];

  const appEnv = ['    environment:', `      - NODE_ENV=production`, `      - PORT=${port}`];
  if (config.services?.redis) appEnv.push('      - REDIS_URL=redis://redis:6379');
  if (config.services?.postgres)
    appEnv.push('      - DATABASE_URL=postgresql://cogitator:cogitator@postgres:5432/cogitator');

  const dependsOn: string[] = [];
  if (config.services?.redis) dependsOn.push('      redis:', '        condition: service_healthy');
  if (config.services?.postgres)
    dependsOn.push('      postgres:', '        condition: service_healthy');

  lines.push('  app:');
  lines.push('    build: .');
  lines.push(`    image: ${config.registry ? `${config.registry}/${image}` : image}`);
  lines.push(`    ports:`);
  lines.push(`      - "${port}:${port}"`);
  lines.push(...appEnv);
  lines.push('    restart: unless-stopped');
  if (dependsOn.length > 0) {
    lines.push('    depends_on:');
    lines.push(...dependsOn);
  }

  if (config.services?.redis) {
    lines.push('');
    lines.push('  redis:');
    lines.push('    image: redis:7-alpine');
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
