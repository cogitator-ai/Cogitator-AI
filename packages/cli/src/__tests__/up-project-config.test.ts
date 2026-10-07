import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { spawnMock, execFileSyncMock, buildMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  buildMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

vi.mock('@cogitator-ai/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cogitator-ai/channels')>();
  return {
    ...actual,
    RuntimeBuilder: class {
      build = buildMock;
    },
  };
});

import { upCommand, findAssistantConfig, loadAssistantConfig } from '../commands/up.js';
import { detectConfigKind } from '../utils/project-config.js';
import { resolveDaemonLaunch } from '../utils/daemon.js';
import { log } from '../utils/logger.js';
import { CommandError } from '../utils/cli.js';

const SCAFFOLDED_RUNTIME_CONFIG = [
  'llm:',
  '  defaultProvider: ollama',
  '  defaultModel: qwen3:8b',
  '  providers:',
  '    ollama:',
  '      baseUrl: ${OLLAMA_BASE_URL:-http://localhost:11434}',
  '',
  'memory:',
  '  adapter: redis',
  '  redis:',
  '    url: ${REDIS_URL:-redis://localhost:6379}',
  '',
].join('\n');

const COMPOSE = 'services:\n  redis:\n    image: redis:7-alpine\n';

describe('detectConfigKind', () => {
  it('tells assistant configs from runtime configs', () => {
    expect(
      detectConfigKind({
        name: 'jarvis',
        personality: 'x',
        llm: { provider: 'ollama', model: 'm' },
      })
    ).toBe('assistant');
    expect(detectConfigKind({ llm: { provider: 'ollama' } })).toBe('assistant');
    expect(detectConfigKind({ channels: {} })).toBe('assistant');
    expect(detectConfigKind(null)).toBe('assistant');
    expect(detectConfigKind({ llm: { defaultModel: 'ollama/qwen3:8b' } })).toBe('runtime');
    expect(detectConfigKind({ memory: { adapter: 'redis' }, sandbox: {} })).toBe('runtime');
  });
});

describe('cogitator up with a runtime cogitator.yml (create-cogitator-app)', () => {
  let dir: string;
  let signalListeners: Map<'SIGINT' | 'SIGTERM', NodeJS.SignalsListener[]>;
  let errors: string[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-up-runtime-')));
    writeFileSync(join(dir, 'cogitator.yml'), SCAFFOLDED_RUNTIME_CONFIG);
    signalListeners = new Map([
      ['SIGINT', process.listeners('SIGINT')],
      ['SIGTERM', process.listeners('SIGTERM')],
    ]);
    spawnMock.mockReset().mockReturnValue({ on: vi.fn(), exitCode: null, kill: vi.fn() });
    execFileSyncMock.mockReset().mockReturnValue('');
    buildMock.mockReset();
    errors = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(log, 'error').mockImplementation((message) => void errors.push(message));
    vi.spyOn(log, 'dim').mockImplementation(() => undefined);
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  });

  afterEach(() => {
    for (const [signal, before] of signalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!before.includes(listener)) process.off(signal, listener);
      }
    }
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not picked up as an assistant config', () => {
    expect(findAssistantConfig(dir)).toBeNull();
    expect(() => loadAssistantConfig(join(dir, 'cogitator.yml'))).toThrow(
      /runtime config for @cogitator-ai\/config/
    );
  });

  it('starts the project Docker Compose services instead of an assistant', async () => {
    writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE);

    await upCommand.parseAsync(['--no-detach'], { from: 'user' });

    expect(errors).toEqual([]);
    expect(buildMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      'docker',
      ['compose', 'up'],
      expect.objectContaining({ cwd: dir })
    );
  });

  it('explains what the file is when there are no services to start', async () => {
    const failure = upCommand.parseAsync([], { from: 'user' });
    await expect(failure).rejects.toBeInstanceOf(CommandError);
    await expect(failure).rejects.toThrow(/runtime config for @cogitator-ai\/config/);
    await expect(failure).rejects.toMatchObject({
      exitCode: 1,
      hints: ['No docker-compose.yml found either, so there are no services to start'],
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('refuses it as an explicit assistant config with the same explanation', async () => {
    await expect(
      upCommand.parseAsync(['--config', join(dir, 'cogitator.yml')], { from: 'user' })
    ).rejects.toThrow(/runtime config for @cogitator-ai\/config/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('is skipped by daemon auto-detection', () => {
    const launch = () =>
      resolveDaemonLaunch({ cwd: dir, nodePath: '/usr/bin/node', cliEntry: '/cli.js' });

    expect(launch).toThrow('Nothing to run');
    expect(() =>
      resolveDaemonLaunch({
        cwd: dir,
        nodePath: '/usr/bin/node',
        cliEntry: '/cli.js',
        config: 'cogitator.yml',
      })
    ).toThrow(/runtime config for @cogitator-ai\/config/);
  });
});
