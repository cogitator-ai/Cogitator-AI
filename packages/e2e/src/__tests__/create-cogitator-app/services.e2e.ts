import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { dockerComposeAvailable, scaffold, startServices } from 'create-cogitator-app';
import { exec, mustExec } from '../../helpers/scaffold-harness';

/**
 * The services the scaffolder starts for an interactive run, on real Docker:
 * a generated project with Redis memory, its port moved to a free one, plus a
 * one-shot service like the Ollama model pull, which compose must start
 * without `--wait`.
 */
const root = mkdtempSync(join(tmpdir(), 'cca-services-'));
const dir = join(root, 'services');
const project = `cca-services-${process.pid}-${Date.now()}`;
const env = { COMPOSE_PROJECT_NAME: project };
let skipped: string | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface ComposeContainer {
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

async function containers(): Promise<ComposeContainer[]> {
  const output = await mustExec('docker', ['compose', 'ps', '--all', '--format', 'json'], {
    cwd: dir,
    env,
  });
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComposeContainer);
}

beforeAll(async () => {
  if (!(await dockerComposeAvailable(root))) {
    skipped = 'Docker with the compose plugin is not running on this machine';
    return;
  }
  process.env.COMPOSE_PROJECT_NAME = project;
  await scaffold(
    {
      name: 'services',
      preset: 'basic',
      app: 'script',
      memory: 'redis',
      features: [],
      provider: 'openai',
      model: 'gpt-6.1-sol',
      packageManager: 'pnpm',
    },
    { directory: dir, install: false, git: false }
  );
  const composePath = join(dir, 'docker-compose.yml');
  const compose = parseDocument(readFileSync(composePath, 'utf-8'));
  const image = String(compose.getIn(['services', 'redis', 'image']));
  compose.setIn(['services', 'redis', 'ports'], [`${await freePort()}:6379`]);
  compose.setIn(['services', 'seed'], {
    image,
    command: ['redis-cli', '-h', 'redis', 'set', 'seeded', 'yes'],
    depends_on: { redis: { condition: 'service_healthy' } },
    restart: 'no',
  });
  writeFileSync(composePath, compose.toString());
}, 120_000);

afterAll(async () => {
  try {
    if (!skipped && existsSync(dir)) {
      await exec('docker', ['compose', 'down', '--volumes', '--remove-orphans'], {
        cwd: dir,
        env,
        timeoutMs: 120_000,
      });
    }
  } finally {
    delete process.env.COMPOSE_PROJECT_NAME;
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

describe('starting the compose services of a new project', () => {
  it('waits for Redis to be healthy and lets the one-shot service run to the end', async (context) => {
    if (skipped) return context.skip(skipped);

    const started = await startServices(dir, {
      services: ['redis', 'seed'],
      oneShotServices: ['seed'],
    });
    if (started.status === 'failed') throw started.error;
    expect(started.status).toBe('done');

    const redis = (await containers()).find((container) => container.Service === 'redis');
    expect(redis).toMatchObject({ State: 'running', Health: 'healthy' });

    const deadline = Date.now() + 60_000;
    let seed: ComposeContainer | undefined;
    while (Date.now() < deadline) {
      seed = (await containers()).find((container) => container.Service === 'seed');
      if (seed?.State === 'exited') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(seed).toMatchObject({ State: 'exited', ExitCode: 0 });

    const value = await mustExec(
      'docker',
      ['compose', 'exec', '-T', 'redis', 'redis-cli', 'get', 'seeded'],
      { cwd: dir, env }
    );
    expect(value.trim()).toBe('yes');
  }, 600_000);
});
