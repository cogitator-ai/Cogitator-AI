import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../cli/args.js';
import { projectNameFromDirectory, resolveDirectory, specFromArgs } from '../cli/resolve.js';

const context = { name: 'demo', packageManager: 'pnpm' as const };

describe('specFromArgs', () => {
  it('starts from the basic preset with Ollama', () => {
    expect(specFromArgs(parseCliArgs(['-y']), context)).toEqual({
      name: 'demo',
      preset: 'basic',
      app: 'script',
      channels: [],
      memory: 'none',
      vectorStore: 'memory',
      features: [],
      provider: 'ollama',
      model: 'qwen3.5:9b',
      deploy: 'none',
      compose: true,
      packageManager: 'pnpm',
      codingAgents: [],
    });
  });

  it('lets flags win over the preset and adds features to its own', () => {
    const spec = specFromArgs(
      parseCliArgs([
        '--preset',
        'assistant',
        '--memory',
        'postgres',
        '--features',
        'rag',
        '-p',
        'openai',
      ]),
      context
    );
    expect(spec).toMatchObject({
      preset: 'assistant',
      memory: 'postgres',
      features: ['harness', 'evals', 'rag'],
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
  });

  it('builds a custom stack from --app without a preset', () => {
    const spec = specFromArgs(parseCliArgs(['--app', 'server']), context);
    expect(spec).toMatchObject({ app: 'server', server: 'hono', memory: 'none' });
    expect(spec.preset).toBeUndefined();
  });

  it('defaults a messaging bot to WebChat and a voice preset to OpenAI', () => {
    expect(specFromArgs(parseCliArgs(['--preset', 'channels']), context).channels).toEqual([
      'webchat',
    ]);
    expect(specFromArgs(parseCliArgs(['--preset', 'voice-realtime']), context)).toMatchObject({
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
  });

  it('runs Tetsu with Bun unless a package manager is given', () => {
    expect(specFromArgs(parseCliArgs(['--preset', 'tetsu']), context).packageManager).toBe('bun');
    expect(
      specFromArgs(parseCliArgs(['--preset', 'tetsu', '--pm', 'npm']), context).packageManager
    ).toBe('npm');
  });
});

describe('project directory', () => {
  it('names the project after the last path segment, also for "."', () => {
    expect(projectNameFromDirectory('apps/bot', '/work')).toBe('bot');
    expect(projectNameFromDirectory('.', '/work/my-agents')).toBe('my-agents');
  });

  it('refuses a directory whose name is not a package name', () => {
    expect(() => resolveDirectory('My Agents', '/work')).toThrow(
      'Invalid project name "My Agents"'
    );
    expect(resolveDirectory('agents', '/work')).toEqual({ path: '/work/agents', name: 'agents' });
  });
});
