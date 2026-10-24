import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { checkDeployFlags, runDeployLogs } from '../commands/deploy.js';
import { UsageError } from '../utils/cli.js';

describe('cogitator deploy logs', () => {
  let dir: string;

  function exitingWith(code: number | null, signal: NodeJS.Signals | null = null) {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', code, signal));
      return child;
    });
  }

  function spawned(): { command: string; args: string[]; options: { stdio?: string } } {
    const [command, args, options] = spawnMock.mock.calls[0] ?? [];
    return { command, args, options };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-deploy-logs-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_DEPLOY_')) vi.stubEnv(key, undefined);
    }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'acme-api', dependencies: { '@cogitator-ai/express': '^1.0.0' } })
    );
    exitingWith(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('on the docker target', () => {
    beforeEach(() => {
      mkdirSync(join(dir, '.cogitator'));
      writeFileSync(join(dir, '.cogitator', 'docker-compose.prod.yml'), 'services: {}\n');
    });

    it('runs docker compose logs for the compose project with the terminal attached', async () => {
      await runDeployLogs(undefined, { push: true });

      const { command, args, options } = spawned();
      expect(command).toBe('docker');
      expect(args).toEqual([
        'compose',
        '-p',
        'acme-api',
        '-f',
        join(dir, '.cogitator', 'docker-compose.prod.yml'),
        'logs',
        '--tail',
        '100',
      ]);
      expect(options.stdio).toBe('inherit');
    });

    it('passes follow, tail, timestamps and the service through as arguments', async () => {
      await runDeployLogs('ollama', { push: true, follow: true, tail: '20', timestamps: true });
      expect(spawned().args.slice(5)).toEqual([
        'logs',
        '--follow',
        '--tail',
        '20',
        '--timestamps',
        'ollama',
      ]);
    });

    it('exits with the code of the logs command', async () => {
      exitingWith(3);
      await runDeployLogs(undefined, { push: true });
      expect(process.exitCode).toBe(3);
    });

    it('exits with 128 and the signal number when a signal stops it', async () => {
      exitingWith(null, 'SIGTERM');
      await runDeployLogs(undefined, { push: true });
      expect(process.exitCode).toBe(143);
    });

    it('fails before spawning anything without a deployment', async () => {
      rmSync(join(dir, '.cogitator'), { recursive: true });
      await expect(runDeployLogs(undefined, { push: true })).rejects.toThrow(
        /No docker deployment found/
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe('on the fly target', () => {
    beforeEach(() => {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'flyctl'), '#!/bin/sh\n');
      chmodSync(join(bin, 'flyctl'), 0o755);
      vi.stubEnv('PATH', bin);
      writeFileSync(join(dir, 'cogitator.yml'), 'deploy:\n  target: fly\n  app: acme-prod\n');
    });

    it('runs flyctl logs for deploy.app and exits after the recent lines', async () => {
      await runDeployLogs(undefined, { push: true });
      expect(spawned()).toMatchObject({
        command: 'flyctl',
        args: ['logs', '--app', 'acme-prod', '--no-tail'],
      });
    });

    it('streams with --follow', async () => {
      await runDeployLogs(undefined, { push: true, follow: true });
      expect(spawned().args).toEqual(['logs', '--app', 'acme-prod']);
    });

    it('refuses the docker-only service name, --tail and --timestamps as usage errors', async () => {
      for (const [service, flags] of [
        ['ollama', {}],
        [undefined, { tail: '50' }],
        [undefined, { timestamps: true }],
      ] as const) {
        await expect(runDeployLogs(service, { push: true, ...flags })).rejects.toBeInstanceOf(
          UsageError
        );
      }
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});

describe('checkDeployFlags', () => {
  it('refuses the logs flags on the other actions', () => {
    for (const action of [undefined, 'status', 'destroy']) {
      expect(() => checkDeployFlags(action, { push: true, follow: true })).toThrow(UsageError);
      expect(() => checkDeployFlags(action, { push: true, tail: '10' })).toThrow(/--tail/);
      expect(() => checkDeployFlags(action, { push: true, timestamps: true })).toThrow(
        /--timestamps does not apply/
      );
    }
    expect(() => checkDeployFlags('status', { push: true, json: true })).not.toThrow();
  });

  it('refuses the deploy flags on logs', () => {
    expect(() => checkDeployFlags('logs', { push: true, json: true, dryRun: true })).toThrow(
      '--json, --dry-run do not apply to cogitator deploy logs'
    );
    expect(() => checkDeployFlags('logs', { push: false })).toThrow(/--no-push/);
    expect(() =>
      checkDeployFlags('logs', { push: true, follow: true, tail: '5', timestamps: true })
    ).not.toThrow();
  });
});
