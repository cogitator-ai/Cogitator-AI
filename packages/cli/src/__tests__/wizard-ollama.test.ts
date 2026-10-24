import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

import { wizardCommand } from '../commands/wizard.js';

const MODEL_LIST = { models: [{ name: 'qwen3:8b', size: 1, modified_at: '' }] };

function headersOf(fetcher: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('cogitator wizard Ollama connection', () => {
  let dir: string;
  let cwd: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-wizard-ollama-'));
    cwd = process.cwd();
    process.chdir(dir);
    for (const key of Object.keys(process.env)) {
      if (/^(COGITATOR_|OLLAMA_|GATEWAY_)/.test(key)) delete process.env[key];
    }
    clack.answers.length = 0;
    clack.answers.push(
      true,
      'Alex',
      'jarvis',
      'ollama',
      'cloud',
      'http://wizard.example',
      'wizard-key',
      'ollama/qwen3:8b',
      [],
      [],
      false,
      '~/.cogitator/memory.db',
      'Be nice'
    );
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function runWizard(config: string): Promise<ReturnType<typeof vi.fn>> {
    writeFileSync(join(dir, 'cogitator.yml'), config);
    const fetchMock = vi.fn(async () => Response.json(MODEL_LIST));
    vi.stubGlobal('fetch', fetchMock);
    await wizardCommand.parseAsync([], { from: 'user' });
    return fetchMock;
  }

  it('uses the URL and key it collected, never the ones the existing config holds', async () => {
    const fetchMock = await runWizard(
      [
        'llm:',
        '  providers:',
        '    ollama:',
        '      baseUrl: http://wizard.example',
        '      apiKey: config-key',
        '      headers:',
        '        X-Gateway-Key: secret',
        '',
      ].join('\n')
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://wizard.example/api/tags');
    expect(headersOf(fetchMock)).toEqual({ Authorization: 'Bearer wizard-key' });
    expect(existsSync(join(dir, 'cogitator.yml'))).toBe(true);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toContain('OLLAMA_API_KEY=wizard-key');
  });

  it('does not fail when the cogitator.yml of the directory cannot be parsed', async () => {
    const fetchMock = await runWizard(
      ['limits:', '  maxConcurrentRuns: not-a-number', ''].join('\n')
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://wizard.example/api/tags');
    expect(headersOf(fetchMock)).toEqual({ Authorization: 'Bearer wizard-key' });
  });
});
