import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  formatProject,
  PRESETS,
  scaffold,
  type PackageManager,
  type ProjectSpecInput,
} from 'create-cogitator-app';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';
import {
  cogitatorDependencies,
  exec,
  hasBinary,
  installArgs,
  mustExec,
  packWorkspace,
  regenerateDockerfile,
  runArgs,
  useTarballs,
} from '../../helpers/scaffold-harness';

/**
 * Every preset with every package manager, installed from the workspace
 * tarballs the way npm would ship them: type-checked, tested on the mocked
 * model, linted and built; servers probed over HTTP against a scripted
 * Ollama; deploys planned; images built when Docker is there.
 *
 * MATRIX_PRESETS and MATRIX_PMS (comma-separated) narrow it down.
 */
const only = (name: string) =>
  process.env[name]
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const PRESET_IDS = only('MATRIX_PRESETS') ?? PRESETS.map((preset) => preset.id);
const PMS = (only('MATRIX_PMS') ?? ['pnpm', 'npm', 'bun']) as PackageManager[];
const TOKEN = 'matrix-token';

const root = mkdtempSync(join(tmpdir(), 'cca-matrix-'));
let model: FakeOllama;
const tarballs: Record<string, string> = {};
const available = new Map<string, boolean>();

beforeAll(async () => {
  model = await startFakeOllama((messages) => {
    const last = messages.at(-1);
    if (last?.role === 'tool') return { content: `Done with ${last.content.slice(0, 40)}` };
    const input = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    return { content: `Hello: ${input.slice(0, 60)}` };
  });
  for (const binary of ['pnpm', 'npm', 'bun', 'docker'])
    available.set(binary, await hasBinary(binary));
}, 60_000);

afterAll(async () => {
  await model?.close();
  rmSync(root, { recursive: true, force: true });
});

/** The text a server-sent event stream carried, from its text deltas. */
function streamedText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6)) as {
        type?: string;
        delta?: string;
        textDelta?: string;
        token?: string;
      };
      if (event.type === 'text-delta' || event.type === 'token')
        text += event.delta ?? event.textDelta ?? event.token ?? '';
    } catch {
      continue;
    }
  }
  return text;
}

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

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${what} did not come up within ${timeoutMs / 1000} s`);
}

function specFor(presetId: string, pm: PackageManager, name: string): ProjectSpecInput {
  const preset = PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error(`no preset ${presetId}`);
  const provider = preset.spec.provider ?? 'ollama';
  return {
    name,
    preset: preset.id,
    ...preset.spec,
    provider,
    model: provider === 'ollama' ? 'qwen3.5:4b' : 'gpt-realtime-mini',
    packageManager: pm,
    deploy: 'docker',
  };
}

/** Tarballs of the workspace packages the project needs, packed once for the whole matrix. */
async function packed(dir: string): Promise<Record<string, string>> {
  const missing = cogitatorDependencies(dir).filter((name) => !tarballs[name]);
  if (missing.length > 0) Object.assign(tarballs, await packWorkspace(missing));
  return { ...tarballs };
}

/** Signals a process group; `false` when it is gone already. */
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Starts the project's `start` script and stops the whole process group afterwards. */
function startProject(dir: string, pm: PackageManager, env: NodeJS.ProcessEnv) {
  const [command, args] = runArgs(pm, 'start');
  const child = spawn(command, args, {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return {
    output: () => output,
    stop: async () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (!killGroup(child.pid, 'SIGTERM')) return;
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => {
          if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
          resolve();
        }, 8_000);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
      });
    },
  };
}

const combos = PRESET_IDS.flatMap((presetId) =>
  PMS.filter((pm) => presetId !== 'tetsu' || pm === 'bun').map((pm) => ({ presetId, pm }))
);

describe.each(combos)('$presetId with $pm', ({ presetId, pm }) => {
  const name = `m-${presetId}-${pm}`;
  const dir = join(root, name);
  const spec = specFor(presetId, pm, name);
  let skipped: string | undefined;
  let scripts: Record<string, string> = {};

  beforeAll(async () => {
    if (!available.get(pm)) {
      skipped = `${pm} is not installed`;
      return;
    }
    await scaffold(spec, { directory: dir, install: false, git: false });
    useTarballs(dir, pm, await packed(dir));
    await mustExec(pm, installArgs(pm), { cwd: dir, timeoutMs: 900_000 });
    const formatted = await formatProject(dir);
    if (formatted.status === 'failed') throw formatted.error;
    scripts = (
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
  }, 1_000_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const script of ['typecheck', 'test', 'lint', 'build']) {
    it(`runs ${script}`, async (context) => {
      if (skipped) return context.skip(skipped);
      if (!scripts[script]) return context.skip(`the project has no ${script} script`);
      const [command, args] = runArgs(pm, script);
      const result = await exec(command, args, {
        cwd: dir,
        env: { OLLAMA_BASE_URL: model.url, CI: '1' },
        timeoutMs: 600_000,
      });
      expect(result.code, result.output.split('\n').slice(-40).join('\n')).toBe(0);
    }, 620_000);
  }

  it('answers over HTTP on the scripted model', async (context) => {
    if (skipped) return context.skip(skipped);
    if (spec.app === 'script' || spec.app === 'worker')
      return context.skip('the preset is not a server');
    const port = await freePort();
    const env = {
      PORT: String(port),
      WEBCHAT_PORT: String(port),
      OLLAMA_BASE_URL: model.url,
      API_TOKEN: TOKEN,
      NODE_ENV: 'production',
    };
    const app = startProject(dir, pm, env);
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    try {
      if (spec.app === 'channels') {
        await waitFor(
          () =>
            new Promise((resolve) => {
              const socket = createConnection(port, '127.0.0.1', () => {
                socket.end();
                resolve(true);
              }).on('error', () => resolve(false));
            }),
          60_000,
          'WebChat'
        );
        return;
      }
      await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 90_000, 'the health check');
      if (spec.app === 'next') {
        const chat = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ messages: [{ role: 'user', content: 'ping from the matrix' }] }),
        });
        expect(chat.status).toBe(200);
        expect(streamedText(await chat.text())).toContain('Hello: ping from the matrix');
        return;
      }
      const run = await fetch(`${base}/api/agents/assistant/run`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ input: 'ping from the matrix' }),
      });
      expect(run.status, app.output()).toBe(200);
      expect(JSON.stringify(await run.json())).toContain('Hello: ping from the matrix');
      const denied = await fetch(`${base}/api/agents/assistant/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'no token' }),
      });
      expect(denied.status).toBe(401);
      const stream = await fetch(`${base}/api/agents/assistant/stream`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ input: 'stream it' }),
      });
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      expect(streamedText(await stream.text())).toContain('Hello: stream it');
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${app.output().slice(-3000)}`,
        {
          cause: error,
        }
      );
    } finally {
      await app.stop();
    }
  }, 300_000);

  it('plans a deploy with its secrets, services and warnings', async (context) => {
    if (skipped) return context.skip(skipped);
    const config = parse(readFileSync(join(dir, 'cogitator.yml'), 'utf-8')) as {
      deploy?: { secrets?: string[] };
      memory?: { adapter?: string };
    };
    const secrets = config.deploy?.secrets ?? [];
    const cli = join(dir, 'node_modules', '.bin', 'cogitator');
    const missing = await exec(cli, ['deploy', '--dry-run', '--json'], {
      cwd: dir,
      env: Object.fromEntries(secrets.map((secret) => [secret, ''])),
    });
    const plan = JSON.parse(missing.output.slice(missing.output.indexOf('{'))) as {
      ok: boolean;
      secrets: string[];
      warnings: string[];
      services: { postgres: boolean; redis: boolean };
      preflight: { checks: Array<{ name: string; passed: boolean }> };
    };
    expect(plan.secrets).toEqual(secrets);
    expect(Array.isArray(plan.warnings)).toBe(true);
    expect(plan.services.postgres).toBe(config.memory?.adapter === 'postgres');
    for (const secret of secrets) {
      expect(plan.preflight.checks).toContainEqual(
        expect.objectContaining({ name: `Secret: ${secret}`, passed: false })
      );
    }
    if (secrets.length > 0) {
      expect(plan.ok).toBe(false);
      expect(missing.code).toBe(1);
    }

    const filled = await exec(cli, ['deploy', '--dry-run', '--json'], {
      cwd: dir,
      env: Object.fromEntries(secrets.map((secret) => [secret, 'set-for-the-matrix'])),
    });
    const ready = JSON.parse(filled.output.slice(filled.output.indexOf('{'))) as {
      preflight: { checks: Array<{ name: string; passed: boolean }> };
    };
    expect(
      ready.preflight.checks.filter((check) => check.name.startsWith('Secret:') && !check.passed)
    ).toEqual([]);
  }, 120_000);
});

describe.each(
  PMS.filter(() => !only('MATRIX_PRESETS') || only('MATRIX_PRESETS')?.includes('hono'))
)('the Docker image of hono with %s', (pm) => {
  it('builds and serves its health check', async (context) => {
    if (!available.get('docker')) return context.skip('Docker is not available on this machine');
    if (!available.get(pm)) return context.skip(`${pm} is not installed`);
    const name = `img-hono-${pm}`;
    const dir = join(root, name);
    await scaffold(specFor('hono', pm, name), { directory: dir, install: false, git: false });
    useTarballs(dir, pm, await packed(dir), { vendor: true });
    await mustExec(pm, installArgs(pm), { cwd: dir, timeoutMs: 900_000 });
    await regenerateDockerfile(dir);
    expect(existsSync(join(dir, 'Dockerfile'))).toBe(true);
    const tag = `cogitator-matrix-${name}:latest`;
    await mustExec('docker', ['build', '-t', tag, '.'], { cwd: dir, timeoutMs: 1_200_000 });
    const port = await freePort();
    const container = `cogitator-matrix-${name}-${port}`;
    await mustExec(
      'docker',
      ['run', '-d', '--name', container, '-p', `${port}:3000`, '-e', `API_TOKEN=${TOKEN}`, tag],
      { cwd: dir }
    );
    try {
      await waitFor(
        async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok,
        60_000,
        'the container'
      );
      const user = await mustExec('docker', ['exec', container, 'whoami'], { cwd: dir });
      expect(user.trim()).not.toBe('root');
    } finally {
      await exec('docker', ['rm', '-f', container], { cwd: dir });
      await exec('docker', ['rmi', '-f', tag], { cwd: dir });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 1_500_000);
});
