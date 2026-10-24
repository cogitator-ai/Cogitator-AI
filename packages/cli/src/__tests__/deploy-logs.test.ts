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

import { runDeployLogs } from '../commands/deploy.js';

describe('cogitator deploy logs', () => {
  let dir: string;
  const saved = { ...process.env };

  function exitingWith(code: number) {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', code, null));
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
      if (key.startsWith('COGITATOR_DEPLOY_')) delete process.env[key];
    }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'acme-api', dependencies: { '@cogitator-ai/express': '^1.0.0' } })
    );
    exitingWith(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
    process.env = { ...saved };
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
      process.env.PATH = bin;
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

    it('refuses a service name, which a Fly app does not have', async () => {
      await expect(runDeployLogs('ollama', { push: true })).rejects.toThrow(/no service name/);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
