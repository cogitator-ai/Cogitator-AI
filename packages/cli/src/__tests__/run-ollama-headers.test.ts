import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { runAgent, closeCogitator } = vi.hoisted(() => ({
  runAgent: vi.fn(),
  closeCogitator: vi.fn(),
}));

vi.mock('@cogitator-ai/core', () => ({
  Cogitator: class {
    run = runAgent;
    close = closeCogitator;
  },
  Agent: class {
    constructor(_config: unknown) {}
  },
}));

import { runCommand } from '../commands/run.js';

describe('run Ollama model detection', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-run-ollama-'));
    for (const key of Object.keys(process.env)) {
      if (/^(COGITATOR_|OLLAMA_|GATEWAY_)/.test(key)) delete process.env[key];
    }
    runAgent.mockResolvedValue({ output: 'ok' });
    closeCogitator.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends headers from cogitator.yml when detecting a model', async () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://ollama.example',
        '      apiKey: ${OLLAMA_API_KEY}',
        '      headers:',
        '        X-Gateway-Key: ${GATEWAY_KEY}',
        '',
      ].join('\n')
    );
    writeFileSync(join(dir, '.env'), 'OLLAMA_API_KEY=from-file\nGATEWAY_KEY=secret\n');
    const fetchMock = vi.fn(async () =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await runCommand.parseAsync(['--config', join(dir, 'cogitator.yml'), '--no-stream', 'hello'], {
      from: 'user',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.example/api/tags',
      expect.objectContaining({
        headers: { 'X-Gateway-Key': 'secret', Authorization: 'Bearer from-file' },
      })
    );
    expect(runAgent).toHaveBeenCalled();
  });

  it('prefers a literal config apiKey over a different OLLAMA_API_KEY', async () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://ollama.example',
        '      apiKey: literal-config-key',
        '',
      ].join('\n')
    );
    process.env.OLLAMA_API_KEY = 'env-key';
    const fetchMock = vi.fn(async () =>
      Response.json({ models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await runCommand.parseAsync(['--config', join(dir, 'cogitator.yml'), '--no-stream', 'hello'], {
      from: 'user',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.example/api/tags',
      expect.objectContaining({ headers: { Authorization: 'Bearer literal-config-key' } })
    );
    expect(runAgent).toHaveBeenCalled();
  });
});
