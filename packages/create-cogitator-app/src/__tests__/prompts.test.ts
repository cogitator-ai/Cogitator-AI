import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { collectOptions, defaultAnswers, parseArgs } from '../prompts.js';

vi.mock('@clack/prompts', () => {
  const unexpectedPrompt = () => {
    throw new Error('prompted although --yes was given');
  };
  return {
    text: vi.fn(unexpectedPrompt),
    select: vi.fn(unexpectedPrompt),
    confirm: vi.fn(unexpectedPrompt),
    cancel: vi.fn(),
    isCancel: (value: unknown) => typeof value === 'symbol',
  };
});

describe('parseArgs', () => {
  it('parses project name from positional arg', () => {
    const result = parseArgs(['my-project']);
    expect(result.name).toBe('my-project');
  });

  it('parses --template flag', () => {
    const result = parseArgs(['--template', 'basic']);
    expect(result.template).toBe('basic');
  });

  it('parses -t shorthand for template', () => {
    const result = parseArgs(['-t', 'swarm']);
    expect(result.template).toBe('swarm');
  });

  it('ignores invalid template values', () => {
    const result = parseArgs(['--template', 'nonexistent']);
    expect(result.template).toBeUndefined();
  });

  it('does not crash when --template has no value', () => {
    expect(() => parseArgs(['--template'])).not.toThrow();
    const result = parseArgs(['--template']);
    expect(result.template).toBeUndefined();
  });

  it('does not crash when --provider has no value', () => {
    expect(() => parseArgs(['--provider'])).not.toThrow();
    const result = parseArgs(['--provider']);
    expect(result.provider).toBeUndefined();
  });

  it('does not crash when --pm has no value', () => {
    expect(() => parseArgs(['--pm'])).not.toThrow();
    const result = parseArgs(['--pm']);
    expect(result.packageManager).toBeUndefined();
  });

  it('parses --provider flag', () => {
    const result = parseArgs(['--provider', 'openai']);
    expect(result.provider).toBe('openai');
  });

  it('parses -p shorthand for provider', () => {
    const result = parseArgs(['-p', 'anthropic']);
    expect(result.provider).toBe('anthropic');
  });

  it('ignores invalid provider values', () => {
    const result = parseArgs(['--provider', 'invalid-llm']);
    expect(result.provider).toBeUndefined();
  });

  it('parses --pm flag', () => {
    const result = parseArgs(['--pm', 'npm']);
    expect(result.packageManager).toBe('npm');
  });

  it('parses --no-install and --install', () => {
    expect(parseArgs(['--no-install']).install).toBe(false);
    expect(parseArgs(['--install']).install).toBe(true);
    expect(parseArgs([]).install).toBeUndefined();
  });

  it('ignores invalid package manager values', () => {
    const result = parseArgs(['--pm', 'cargo']);
    expect(result.packageManager).toBeUndefined();
  });

  it('parses --docker flag', () => {
    const result = parseArgs(['--docker']);
    expect(result.docker).toBe(true);
  });

  it('parses --no-docker flag', () => {
    const result = parseArgs(['--no-docker']);
    expect(result.docker).toBe(false);
  });

  it('parses --git flag', () => {
    const result = parseArgs(['--git']);
    expect(result.git).toBe(true);
  });

  it('parses --no-git flag', () => {
    const result = parseArgs(['--no-git']);
    expect(result.git).toBe(false);
  });

  it('parses -y flag', () => {
    const result = parseArgs(['-y']);
    expect(result.yes).toBe(true);
  });

  it('parses --yes flag', () => {
    const result = parseArgs(['--yes']);
    expect(result.yes).toBe(true);
  });

  it('parses all flags together', () => {
    const result = parseArgs([
      'my-app',
      '--template',
      'workflow',
      '--provider',
      'google',
      '--pm',
      'bun',
      '--docker',
      '--no-git',
    ]);
    expect(result.name).toBe('my-app');
    expect(result.template).toBe('workflow');
    expect(result.provider).toBe('google');
    expect(result.packageManager).toBe('bun');
    expect(result.docker).toBe(true);
    expect(result.git).toBe(false);
  });

  it('does not pick up flags as project name', () => {
    const result = parseArgs(['--docker', 'my-project']);
    expect(result.name).toBe('my-project');
  });

  it('only captures first positional as name', () => {
    const result = parseArgs(['first', 'second']);
    expect(result.name).toBe('first');
  });

  it('parses --model', () => {
    expect(parseArgs(['--model', 'llama3.2:3b']).model).toBe('llama3.2:3b');
    expect(parseArgs(['--model']).model).toBeUndefined();
  });

  it('returns empty object for no args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({});
  });
});

describe('collectOptions with --yes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers every prompt with its default', async () => {
    vi.stubEnv('npm_config_user_agent', 'pnpm/11.0.0 npm/? node/v22.0.0');

    const options = await collectOptions(parseArgs(['-y']));

    expect(options).toEqual({
      name: defaultAnswers.name,
      path: path.resolve(process.cwd(), defaultAnswers.name),
      template: 'basic',
      provider: 'ollama',
      packageManager: 'pnpm',
      docker: true,
      git: true,
    });
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('passes --no-install through without prompting', async () => {
    const options = await collectOptions(parseArgs(['-y', '--no-install']));

    expect(options.install).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('keeps the answers given as arguments', async () => {
    const options = await collectOptions(
      parseArgs([
        './apps/bot',
        '--yes',
        '-t',
        'swarm',
        '-p',
        'google',
        '--pm',
        'bun',
        '--no-docker',
        '--no-git',
      ])
    );

    expect(options).toMatchObject({
      name: 'bot',
      template: 'swarm',
      provider: 'google',
      packageManager: 'bun',
      docker: false,
      git: false,
    });
  });

  it('picks npm when launched through npx', async () => {
    vi.stubEnv('npm_config_user_agent', 'npm/10.9.8 node/v22.23.1 darwin arm64 workspaces/false');

    expect((await collectOptions({ yes: true })).packageManager).toBe('npm');
  });

  it('names the project after the current directory for "."', async () => {
    const options = await collectOptions({ yes: true, name: '.' });

    expect(options.path).toBe(process.cwd());
    expect(options.name).toBe(path.basename(process.cwd()));
  });

  it('refuses a directory name that is not a valid package name', async () => {
    await expect(collectOptions({ yes: true, name: "bob's agents" })).rejects.toThrow(
      /Invalid project name "bob's agents"/
    );
  });

  it('keeps --model for the agents', async () => {
    const options = await collectOptions(parseArgs(['-y', '--model', 'qwen2.5:0.5b']));

    expect(options.model).toBe('qwen2.5:0.5b');
  });

  it('uses the package manager it was launched with', async () => {
    vi.stubEnv('npm_config_user_agent', 'yarn/4.0.0 npm/? node/v22.0.0');

    expect((await collectOptions({ yes: true })).packageManager).toBe('yarn');
  });
});
