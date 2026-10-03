import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { spawnMock, buildMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  buildMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
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

import { upCommand } from '../commands/up.js';
import { log } from '../utils/logger.js';

describe('cogitator up restart supervisor', () => {
  let dir: string;
  let signalListeners: Map<'SIGINT' | 'SIGTERM', NodeJS.SignalsListener[]>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-up-supervisor-'));
    signalListeners = new Map([
      ['SIGINT', process.listeners('SIGINT')],
      ['SIGTERM', process.listeners('SIGTERM')],
    ]);
    spawnMock.mockReset().mockReturnValue({ on: vi.fn(), exitCode: null, kill: vi.fn() });
    buildMock.mockReset().mockRejectedValue(new Error('runtime must be built in the child'));
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

  it('supervises restarts when selfConfig is off, so /restart (exit 78) relaunches', async () => {
    const configPath = join(dir, 'cogitator.yml');
    writeFileSync(
      configPath,
      [
        'name: jarvis',
        'personality: helpful',
        'llm:',
        '  provider: ollama',
        '  model: qwen2.5:0.5b',
        'channels:',
        '  telegram:',
        '    ownerIds: ["42"]',
        '',
      ].join('\n')
    );

    await upCommand.parseAsync(['--config', configPath], { from: 'user' });

    expect(buildMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], 'up', '--no-restart-loop', '--config', configPath],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('lists only the channels that started, not ones skipped for a missing token', async () => {
    const configPath = join(dir, 'cogitator.yml');
    writeFileSync(
      configPath,
      [
        'name: jarvis',
        'personality: helpful',
        'llm:',
        '  provider: ollama',
        '  model: qwen2.5:0.5b',
        'channels:',
        '  telegram:',
        '    ownerIds: ["42"]',
        '  webchat:',
        '    port: 8080',
        '',
      ].join('\n')
    );
    buildMock.mockReset().mockResolvedValue({
      gateway: {
        start: vi.fn().mockResolvedValue(undefined),
        stats: { connectedChannels: ['telegram'] },
      },
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const lines: string[] = [];
    vi.spyOn(log, 'dim').mockImplementation((message) => void lines.push(message));
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    vi.spyOn(log, 'success').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await upCommand.parseAsync(['--no-restart-loop', '--config', configPath], { from: 'user' });

    expect(lines).toContain('  Channels: telegram');
    expect(lines.join('\n')).not.toContain('webchat');
  });
});
