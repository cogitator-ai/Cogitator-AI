import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOllamaUrl, getTestModel, isOllamaRunning } from '../../helpers/setup';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const CLI_PKG = fileURLToPath(new URL('../../../../cli/package.json', import.meta.url));
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.tmp-cli-e2e', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return predicate();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('CLI binary', () => {
  let workDir: string;

  beforeAll(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
  });

  afterAll(() => {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(SCRATCH_ROOT, 'project-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('prints the package version', () => {
    const pkg = JSON.parse(readFileSync(CLI_PKG, 'utf-8')) as { version: string };
    const result = cli(['--version'], workDir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('lists all commands in help', () => {
    const result = cli(['--help'], workDir);
    expect(result.status).toBe(0);
    for (const command of [
      'init',
      'wizard',
      'up',
      'run',
      'assistant',
      'build',
      'daemon',
      'skill',
      'deploy',
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  describe('skill', () => {
    it('creates, validates, lists and removes a skill', () => {
      const create = cli(['skill', 'create', 'weather-api', '--template', 'api'], workDir);
      expect(create.status).toBe(0);
      expect(existsSync(join(workDir, 'skills/weather-api/skill.ts'))).toBe(true);
      expect(existsSync(join(workDir, 'skills/weather-api/tools/weather-api.ts'))).toBe(true);

      const missingEnv = cli(['skill', 'validate', 'skills/weather-api'], workDir, {
        WEATHER_API_API_KEY: '',
      });
      expect(missingEnv.status).toBe(1);
      expect(missingEnv.stdout).toContain('WEATHER_API_API_KEY');

      const valid = cli(['skill', 'validate', 'skills/weather-api'], workDir, {
        WEATHER_API_API_KEY: 'test-key',
      });
      expect(valid.stdout).toContain('Skill is valid');
      expect(valid.status).toBe(0);

      const list = cli(['skill', 'list'], workDir);
      expect(list.stdout).toContain('weather-api');

      const remove = cli(['skill', 'remove', 'weather-api'], workDir);
      expect(remove.status).toBe(0);
      expect(existsSync(join(workDir, 'skills/weather-api'))).toBe(false);
    });

    it('rejects path traversal in skill names', () => {
      const create = cli(['skill', 'create', '../escape'], workDir);
      expect(create.status).not.toBe(0);
      expect(existsSync(join(workDir, 'escape'))).toBe(false);

      const remove = cli(['skill', 'remove', '../../etc'], workDir);
      expect(remove.status).not.toBe(0);
    });

    it('exits non-zero when removing an unknown skill', () => {
      expect(cli(['skill', 'remove', 'nope'], workDir).status).toBe(1);
    });
  });

  describe('deploy', () => {
    it('rejects targets without a provider', () => {
      const result = cli(['deploy', '--target', 'k8s', '--dry-run'], workDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Available targets: docker, fly');
    });

    it('shows a plan with detected secrets for a dry run', () => {
      writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'e2e-deploy-app' }));
      writeFileSync(join(workDir, 'cogitator.yml'), 'llm:\n  defaultModel: openai/gpt-4o\n');
      const result = cli(['deploy', '--dry-run', '--target', 'docker'], workDir, {
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.stdout).toContain('Deploy plan for docker');
      expect(result.stdout).toContain('OPENAI_API_KEY');
      expect(result.stdout).toContain('e2e-deploy-app');
    });

    it('fails clearly when an explicit config file is missing', () => {
      const result = cli(['deploy', '--dry-run', '-c', 'missing.yml'], workDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Config file not found');
    });
  });

  describe('run', () => {
    it('fails clearly when an explicit config file is missing', () => {
      const result = cli(['run', '-c', 'missing.yml', 'hi'], workDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Config file not found');
    });
  });

  describe.skipIf(process.platform === 'win32')('daemon', () => {
    it('runs a gateway module in the background and stops it gracefully', async () => {
      writeFileSync(
        join(workDir, 'gateway.mjs'),
        `let timer;
export const gateway = {
  stats: { uptime: 0, activeSessions: 0, totalSessions: 0, messagesToday: 0, connectedChannels: ['e2e'] },
  async start() { timer = setInterval(() => {}, 1000); console.log('E2E_GATEWAY_STARTED'); },
  async stop() { clearInterval(timer); console.log('E2E_GATEWAY_STOPPED'); },
};
`
      );

      const start = cli(['daemon', 'start', '-c', 'gateway.mjs'], workDir);
      expect(start.status).toBe(0);
      const pidMatch = /PID: (\d+)/.exec(start.stdout);
      expect(pidMatch).not.toBeNull();
      const pid = Number(pidMatch?.[1]);
      const logFile = join(workDir, '.cogitator/daemon.log');

      try {
        const started = await waitFor(
          () =>
            existsSync(logFile) && readFileSync(logFile, 'utf-8').includes('E2E_GATEWAY_STARTED')
        );
        expect(started).toBe(true);
        expect(isAlive(pid)).toBe(true);

        const status = cli(['daemon', 'status'], workDir);
        expect(status.stdout).toContain('running');
        expect(status.stdout).toContain(String(pid));

        const again = cli(['daemon', 'start', '-c', 'gateway.mjs'], workDir);
        expect(again.stdout).toContain('already running');

        const stop = cli(['daemon', 'stop'], workDir);
        expect(stop.status).toBe(0);
        expect(stop.stdout).toContain('Daemon stopped');
        expect(await waitFor(() => !isAlive(pid))).toBe(true);
        expect(readFileSync(logFile, 'utf-8')).toContain('E2E_GATEWAY_STOPPED');
        expect(existsSync(join(workDir, '.cogitator/daemon.pid'))).toBe(false);
      } finally {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    });

    it('cleans up a stale pid file', () => {
      mkdirSync(join(workDir, '.cogitator'));
      writeFileSync(join(workDir, '.cogitator/daemon.pid'), '999999\n');
      const status = cli(['daemon', 'status'], workDir);
      expect(status.stdout).toContain('stopped');
      expect(existsSync(join(workDir, '.cogitator/daemon.pid'))).toBe(false);
    });
  });
});

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeOllama('CLI with Ollama', () => {
  let workDir: string;
  let ollamaUp = false;
  const ollamaEnv = { OLLAMA_URL: getOllamaUrl(), OLLAMA_HOST: '', OLLAMA_API_KEY: '' };

  beforeAll(async () => {
    ollamaUp = await isOllamaRunning();
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    workDir = mkdtempSync(join(SCRATCH_ROOT, 'ollama-'));
  });

  afterAll(() => {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  it('lists the test model', ({ skip }) => {
    if (!ollamaUp) skip();
    const result = cli(['models'], workDir, ollamaEnv);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(getTestModel());
  });

  it('runs a one-shot prompt without streaming', ({ skip }) => {
    if (!ollamaUp) skip();
    const result = cli(
      ['run', '--no-stream', '-m', `ollama/${getTestModel()}`, 'Reply with the single word: pong'],
      workDir,
      ollamaEnv
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('streams tokens and uses llm.defaultModel from cogitator.yml', ({ skip }) => {
    if (!ollamaUp) skip();
    writeFileSync(
      join(workDir, 'cogitator.yml'),
      `llm:\n  defaultModel: ollama/${getTestModel()}\n`
    );
    const result = cli(['run', 'Say hello in one short sentence.'], workDir, {
      ...ollamaEnv,
      COGITATOR_MODEL: '',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Using config');
    expect(result.stdout).not.toContain('Auto-detected model');
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});
