import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import type { Requirement, ServiceName, ServiceUrls } from './types.js';

const run = promisify(execFile);

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    await run(command, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function portOpen(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function playwrightReady(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/** Probes each kind of requirement once per run and answers why a missing one is missing. */
export class RequirementProbe {
  private readonly cache = new Map<string, Promise<string | undefined>>();

  constructor(private readonly services: ServiceUrls) {}

  /** `undefined` when met, otherwise a human-readable reason. */
  async missing(requirement: Requirement): Promise<string | undefined> {
    const key = JSON.stringify(requirement);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.probe(requirement);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async probe(requirement: Requirement): Promise<string | undefined> {
    switch (requirement.kind) {
      case 'env':
        return process.env[requirement.name]
          ? undefined
          : `${requirement.name} is not set${requirement.why ? ` (${requirement.why})` : ''}`;
      case 'docker':
        return (await commandWorks('docker', ['info', '--format', '{{.ServerVersion}}']))
          ? undefined
          : 'Docker daemon is not reachable';
      case 'bun':
        return (await commandWorks('bun', ['--version'])) ? undefined : 'Bun is not installed';
      case 'deno':
        return (await commandWorks('deno', ['--version'])) ? undefined : 'Deno is not installed';
      case 'playwright':
        return (await playwrightReady())
          ? undefined
          : 'Playwright Chromium is not installed (npx playwright install chromium)';
      case 'ollama': {
        const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
        try {
          const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
          const body = (await response.json()) as { models?: Array<{ name: string }> };
          const names = (body.models ?? []).map((model) => model.name);
          const wanted = requirement.model.includes(':')
            ? requirement.model
            : `${requirement.model}:latest`;
          return names.includes(wanted)
            ? undefined
            : `Ollama at ${base} does not have ${requirement.model} (ollama pull ${requirement.model})`;
        } catch {
          return `Ollama is not reachable at ${base} (ollama serve)`;
        }
      }
      case 'service':
        return (await portOpen(this.services[requirement.name]))
          ? undefined
          : `${serviceLabel(requirement.name)} is not reachable at ${this.services[requirement.name]} (docker compose -f packages/gauntlet/compose.yml up -d)`;
    }
  }
}

function serviceLabel(name: ServiceName): string {
  return { postgres: 'Postgres', redis: 'Redis', qdrant: 'Qdrant', mongodb: 'MongoDB' }[name];
}
