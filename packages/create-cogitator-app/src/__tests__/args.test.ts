import { describe, it, expect } from 'vitest';
import {
  CliError,
  closest,
  isInteractive,
  parseCliArgs,
  parseRemoteTemplate,
} from '../cli/args.js';

describe('parseCliArgs', () => {
  it('reads every stack, model and tooling flag', () => {
    expect(
      parseCliArgs([
        'my-app',
        '--app',
        'server',
        '--server',
        'fastify',
        '--memory',
        'postgres',
        '--features',
        'rag,evals',
        '--with',
        'otel',
        '--vector-store',
        'qdrant',
        '--deploy',
        'fly',
        '--no-docker',
        '-p',
        'anthropic',
        '-m',
        'claude-sonnet-5-5',
        '--api-key',
        'sk-ant',
        '--pm',
        'npm',
        '--agent',
        'claude,cursor',
        '--no-git',
        '--no-install',
        '--no-telemetry',
        '-y',
      ])
    ).toEqual({
      directory: 'my-app',
      app: 'server',
      server: 'fastify',
      memory: 'postgres',
      features: ['rag', 'evals', 'otel'],
      vectorStore: 'qdrant',
      deploy: 'fly',
      compose: false,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant',
      packageManager: 'npm',
      codingAgents: ['claude', 'cursor'],
      git: false,
      install: false,
      telemetry: false,
      yes: true,
      dryRun: false,
      json: false,
      help: false,
      version: false,
      listTemplates: false,
      listExamples: false,
    });
  });

  it('reads --template as a preset, keeping its old names working', () => {
    expect(parseCliArgs(['--template', 'api-server']).preset).toBe('api-server');
    expect(parseCliArgs(['-t', 'nextjs']).preset).toBe('nextjs');
  });

  it('reads a GitHub repository as a remote template', () => {
    expect(parseCliArgs(['--template', 'github:acme/agents/starters/bot#v2']).remote).toEqual({
      owner: 'acme',
      repo: 'agents',
      path: 'starters/bot',
      ref: 'v2',
    });
  });

  it('refuses an unknown option and suggests the closest one', () => {
    expect(() => parseCliArgs(['--tempalte', 'basic'])).toThrow(
      'Unknown option --tempalte. Did you mean --template?'
    );
  });

  it('refuses an invalid value even with --yes, listing the valid ones', () => {
    expect(() => parseCliArgs(['--yes', '--memory', 'sqllite'])).toThrow(
      'Invalid --memory "sqllite". Did you mean "sqlite"? Use one of: none, memory, sqlite, postgres, redis, mongodb.'
    );
    expect(() => parseCliArgs(['--yes', '--features', 'rag,ragg'])).toThrow('Did you mean "rag"?');
    expect(() => parseCliArgs(['-y', '--preset', 'assitant'])).toThrow('Did you mean "assistant"?');
  });

  it('refuses a second directory, an empty key and conflicting presets', () => {
    expect(() => parseCliArgs(['a', 'b'])).toThrow(CliError);
    expect(() => parseCliArgs(['--api-key', ' '])).toThrow('--api-key is empty.');
    expect(() => parseCliArgs(['--preset', 'basic', '--template', 'rag'])).toThrow(
      'name different presets'
    );
    expect(() => parseCliArgs(['--preset', 'basic', '--example', 'core/01'])).toThrow('--example');
  });

  it('treats --agent none as no coding agent', () => {
    expect(parseCliArgs(['--agent', 'none']).codingAgents).toEqual([]);
  });
});

describe('parseRemoteTemplate', () => {
  it('accepts github: and https URLs', () => {
    expect(parseRemoteTemplate('github:acme/agents')).toEqual({ owner: 'acme', repo: 'agents' });
    expect(parseRemoteTemplate('https://github.com/acme/agents.git')).toEqual({
      owner: 'acme',
      repo: 'agents',
    });
  });

  it('reads a directory and a ref, tags with @ included', () => {
    expect(
      parseRemoteTemplate('github:acme/agents/bots/support#create-cogitator-app@0.4.0')
    ).toEqual({
      owner: 'acme',
      repo: 'agents',
      path: 'bots/support',
      ref: 'create-cogitator-app@0.4.0',
    });
    expect(parseRemoteTemplate('github:acme/agents#feature/v2').ref).toBe('feature/v2');
  });

  it('refuses anything else', () => {
    expect(() => parseRemoteTemplate('github:acme/agents#bad ref')).toThrow(
      'Invalid remote template'
    );
    expect(() => parseRemoteTemplate('gitlab:acme/agents')).toThrow('Invalid remote template');
    expect(() => parseRemoteTemplate('github:acme')).toThrow('Invalid remote template');
  });
});

describe('closest', () => {
  it('only suggests close matches', () => {
    expect(closest('fastfy', ['fastify', 'hono'])).toBe('fastify');
    expect(closest('xyz', ['fastify', 'hono'])).toBeUndefined();
  });
});

describe('isInteractive', () => {
  it('asks only at a terminal, outside CI, without --yes or --json', () => {
    const tty = { isTTY: true };
    expect(isInteractive({ yes: false, json: false }, {}, tty)).toBe(true);
    expect(isInteractive({ yes: true, json: false }, {}, tty)).toBe(false);
    expect(isInteractive({ yes: false, json: true }, {}, tty)).toBe(false);
    expect(isInteractive({ yes: false, json: false }, { CI: 'true' }, tty)).toBe(false);
    expect(isInteractive({ yes: false, json: false }, { CI: 'false' }, tty)).toBe(true);
    expect(isInteractive({ yes: false, json: false }, {}, { isTTY: false })).toBe(false);
  });
});
