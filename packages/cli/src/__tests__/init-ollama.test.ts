import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scaffold = vi.hoisted(() => vi.fn());
const servicesToStart = vi.hoisted(() => vi.fn(() => []));
const offerServices = vi.hoisted(() => vi.fn(async () => false));

vi.mock('create-cogitator-app', async (importOriginal) => {
  const actual = await importOriginal<typeof import('create-cogitator-app')>();
  return { ...actual, scaffold, servicesToStart, offerServices, isInteractive: () => false };
});

const clack = vi.hoisted(() => {
  const answers: unknown[] = [];
  const take = (): unknown => {
    const value = answers.shift();
    if (value === undefined) throw new Error('No scripted answer left for the prompt');
    return value;
  };
  return {
    answers,
    take,
    spinner: { start: vi.fn(), stop: vi.fn(), error: vi.fn() },
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
});

vi.mock('@clack/prompts', () => ({
  intro: clack.intro,
  outro: clack.outro,
  note: clack.note,
  cancel: clack.cancel,
  log: clack.log,
  text: vi.fn(async () => clack.take()),
  password: vi.fn(async () => clack.take()),
  select: vi.fn(async () => clack.take()),
  multiselect: vi.fn(async () => clack.take()),
  confirm: vi.fn(async () => clack.take()),
  spinner: () => clack.spinner,
  isCancel: () => false,
}));

import { initCommand } from '../commands/init.js';

const MODEL_LIST = { models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] };

describe('cogitator init Ollama connection', () => {
  let dir: string;
  let cwd: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-init-ollama-'));
    cwd = process.cwd();
    process.chdir(dir);
    for (const key of Object.keys(process.env)) {
      if (/^(COGITATOR_|OLLAMA_|GATEWAY_)/.test(key)) delete process.env[key];
    }
    process.env.OLLAMA_BASE_URL = 'http://env.example';
    process.env.OLLAMA_API_KEY = 'env-key';
    clack.answers.length = 0;
    clack.answers.push('ollama', 'ollama/qwen3:8b', ['webchat'], 'sqlite');
    scaffold.mockReset().mockImplementation(async () => ({
      plan: {
        spec: { name: 'my-bot' },
        nextSteps: () => [{ command: 'cogitator up', note: '' }],
      },
      install: { status: 'done' },
    }));
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function runInit(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    vi.stubGlobal('fetch', fetchMock);
    await initCommand.parseAsync(['my-bot', '--no-install', '--no-git', '--no-telemetry'], {
      from: 'user',
    });
  }

  it('lists models from the environment, not from the cogitator.yml of the directory', async () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://config.example',
        '      apiKey: config-key',
        '      headers:',
        '        X-Gateway-Key: secret',
        '',
      ].join('\n')
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(MODEL_LIST));

    await runInit(fetchMock);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://env.example/api/tags');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ headers: { Authorization: 'Bearer env-key' } })
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('http://config.example'))
    ).toBe(false);
    expect(scaffold).toHaveBeenCalled();
  });

  it('does not fail when the cogitator.yml of the directory cannot be parsed', async () => {
    writeFileSync(
      join(dir, 'cogitator.yml'),
      ['limits:', '  maxConcurrentRuns: not-a-number', ''].join('\n')
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(MODEL_LIST));

    await runInit(fetchMock);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://env.example/api/tags');
    expect(scaffold).toHaveBeenCalled();
  });
});
