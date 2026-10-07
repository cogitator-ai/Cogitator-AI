import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProject, writeFiles, type ProjectSpecInput } from 'create-cogitator-app';
import {
  canConnect,
  endpointOf,
  installedVersion,
  loadProjectEnv,
  requiredVariables,
  runDoctor,
  satisfiesMinimum,
} from '../utils/doctor.js';
import { formatChecks } from '../commands/doctor.js';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
  vi.unstubAllEnvs();
});

async function project(spec: Partial<ProjectSpecInput> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-doctor-'));
  dirs.push(dir);
  await writeFiles(
    dir,
    planProject({
      name: 'doctor-test',
      app: 'script',
      memory: 'none',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      packageManager: 'pnpm',
      ...spec,
    }).files
  );
  return dir;
}

function installFake(dir: string, name: string, version: string): void {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
}

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end());
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

describe('doctor helpers', () => {
  it('compares versions against a minimum', () => {
    expect(satisfiesMinimum('v22.23.1', '>=22.12.0')).toBe(true);
    expect(satisfiesMinimum('v22.11.9', '>=22.12.0')).toBe(false);
    expect(satisfiesMinimum('v24.0.0', '>=22.12.0')).toBe(true);
  });

  it('reads the required variables from .env.example', async () => {
    const dir = await project();
    expect(requiredVariables(dir)).toEqual(['OPENAI_API_KEY']);
  });

  it('parses service endpoints with default ports', () => {
    expect(endpointOf('redis://cache:6380', 6379)).toEqual({ host: 'cache', port: 6380 });
    expect(endpointOf('postgresql://u:p@db/app', 5432)).toEqual({ host: 'db', port: 5432 });
    expect(endpointOf('not a url', 1)).toBeUndefined();
  });

  it('fills the environment from .env without overriding the shell', async () => {
    const dir = await project();
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=from-file\nEXTRA=1\n');
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'from-shell' };
    loadProjectEnv(dir, env);
    expect(env).toEqual({ OPENAI_API_KEY: 'from-shell', EXTRA: '1' });
  });
});

describe('runDoctor', () => {
  it('reports a project that is not installed and has no key', async () => {
    const dir = await project();
    const checks = await runDoctor({
      projectDir: dir,
      env: {},
      nodeVersion: 'v22.23.1',
      probe: false,
    });

    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['node', 'pass'],
      ['packages', 'fail'],
      ['config', 'pass'],
      ['env', 'fail'],
    ]);
    expect(checks.find((c) => c.id === 'env')?.detail).toBe('missing OPENAI_API_KEY');
    expect(formatChecks(checks)).toContain('2 problems to fix');
  });

  it('passes an installed project with a working key', async () => {
    const dir = await project();
    for (const name of [
      '@cogitator-ai/core',
      '@cogitator-ai/config',
      '@cogitator-ai/cli',
      '@cogitator-ai/test-utils',
    ]) {
      installFake(dir, name, '1.0.0');
    }
    const fetcher = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));

    const checks = await runDoctor({
      projectDir: dir,
      env: { OPENAI_API_KEY: 'sk-test' },
      nodeVersion: 'v24.1.0',
      probe: true,
      fetch: fetcher,
    });

    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.find((c) => c.id === 'model')?.detail).toBe('OPENAI_API_KEY works');
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.stringify(init.headers)).toContain('Bearer sk-test');
  });

  it('fails on a rejected key and points at where to get a new one', async () => {
    const dir = await project();
    const checks = await runDoctor({
      projectDir: dir,
      env: { OPENAI_API_KEY: 'sk-wrong' },
      nodeVersion: 'v24.1.0',
      probe: true,
      fetch: async () => new Response('unauthorized', { status: 401 }),
    });
    const model = checks.find((c) => c.id === 'model');
    expect(model?.status).toBe('fail');
    expect(model?.fix).toContain('platform.openai.com');
  });

  it('checks that the memory service answers', async () => {
    const { port } = await listen();
    const dir = await project({ memory: 'postgres' });
    vi.stubEnv('DATABASE_URL', `postgresql://cogitator:cogitator@127.0.0.1:${port}/cogitator`);

    const up = await runDoctor({
      projectDir: dir,
      env: { OPENAI_API_KEY: 'sk' },
      nodeVersion: 'v24.1.0',
      probe: true,
      fetch: async () => new Response('{}', { status: 200 }),
    });
    expect(up.find((c) => c.id === 'memory')).toMatchObject({ status: 'pass' });

    vi.stubEnv('DATABASE_URL', 'postgresql://cogitator:cogitator@127.0.0.1:1/cogitator');
    const down = await runDoctor({
      projectDir: dir,
      env: { OPENAI_API_KEY: 'sk' },
      nodeVersion: 'v24.1.0',
      probe: true,
      fetch: async () => new Response('{}', { status: 200 }),
    });
    expect(down.find((c) => c.id === 'memory')).toMatchObject({
      status: 'fail',
      fix: 'docker compose up -d postgres',
    });
  });

  it('fails outside a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-doctor-empty-'));
    dirs.push(dir);
    const checks = await runDoctor({
      projectDir: dir,
      env: {},
      nodeVersion: 'v24.1.0',
      probe: false,
    });
    expect(checks).toMatchObject([{ id: 'project', status: 'fail' }]);
  });

  it('times out on an unreachable host instead of hanging', async () => {
    const started = Date.now();
    expect(await canConnect('10.255.255.1', 9, 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('installedVersion', () => {
  it('finds a package hoisted to a parent node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'cogitator-doctor-hoist-'));
    dirs.push(root);
    const app = join(root, 'apps', 'bot');
    mkdirSync(app, { recursive: true });
    installFake(root, '@cogitator-ai/core', '0.34.0');
    expect(installedVersion(app, '@cogitator-ai/core')).toBe('0.34.0');
    expect(installedVersion(app, '@cogitator-ai/memory')).toBeUndefined();
  });

  it("reads a Yarn Plug'n'Play install through its API, without node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-doctor-pnp-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, '.pnp.cjs'),
      `module.exports = {
        findPackageLocator: () => ({ name: 'bot', reference: 'workspace:.' }),
        getPackageInformation: () => ({
          packageDependencies: new Map([
            ['@cogitator-ai/core', 'npm:0.34.0'],
            ['@cogitator-ai/memory', ['@cogitator-ai/memory', 'virtual:abc123#npm:0.12.1']],
            ['@cogitator-ai/broken', null],
          ]),
        }),
      };\n`
    );
    expect(installedVersion(dir, '@cogitator-ai/core')).toBe('0.34.0');
    expect(installedVersion(dir, '@cogitator-ai/memory')).toBe('0.12.1');
    expect(installedVersion(dir, '@cogitator-ai/broken')).toBeUndefined();
    expect(installedVersion(dir, '@cogitator-ai/channels')).toBeUndefined();
  });
});
