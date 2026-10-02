import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export interface ComposeService {
  Name: string;
  State: string;
  Status: string;
  Health?: string;
  ports: string[];
}

export function findDockerCompose(): string | null {
  let dir = process.cwd();
  for (let depth = 0; depth <= 5; depth++) {
    for (const name of COMPOSE_FILES) {
      const full = resolve(dir, name);
      if (existsSync(full)) return full;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function checkDocker(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'pipe',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPorts(publishers: unknown): string[] {
  if (!Array.isArray(publishers)) return [];
  const ports = new Set<string>();
  for (const publisher of publishers) {
    if (!isRecord(publisher)) continue;
    const published = publisher.PublishedPort;
    const target = publisher.TargetPort;
    if (typeof published !== 'number' || published === 0) continue;
    const host = typeof publisher.URL === 'string' && publisher.URL ? publisher.URL : 'localhost';
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    ports.add(`${displayHost}:${published}${typeof target === 'number' ? `→${target}` : ''}`);
  }
  return [...ports];
}

function toComposeService(record: unknown): ComposeService | null {
  if (!isRecord(record)) return null;
  const name = record.Name ?? record.Service;
  if (typeof name !== 'string') return null;
  return {
    Name: name,
    State: typeof record.State === 'string' ? record.State : 'unknown',
    Status: typeof record.Status === 'string' ? record.Status : '',
    Health: typeof record.Health === 'string' && record.Health ? record.Health : undefined,
    ports: toPorts(record.Publishers),
  };
}

export function parseComposePs(output: string): ComposeService[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const parsed: unknown = trimmed.startsWith('[') ? JSON.parse(trimmed) : null;
  const raw: unknown[] = Array.isArray(parsed)
    ? parsed
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);

  return raw.map(toComposeService).filter((s): s is ComposeService => s !== null);
}

export function composePs(composeDir: string): ComposeService[] {
  const output = execFileSync('docker', ['compose', 'ps', '--format', 'json'], {
    cwd: composeDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseComposePs(output);
}
