import { describe, it, expect } from 'vitest';
import { planProject } from 'create-cogitator-app';
import {
  DEFAULT_POSTGRES_URL,
  initSecrets,
  initSpec,
  validateProjectName,
  type InitAnswers,
} from '../commands/init.js';

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    projectName: 'my-assistant',
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'openai/gpt-6.1-sol',
    channels: ['webchat'],
    memory: 'sqlite',
    ...overrides,
  };
}

describe('validateProjectName', () => {
  it('accepts npm-style names', () => {
    expect(validateProjectName('my-assistant')).toBeUndefined();
    expect(validateProjectName('bot.v2')).toBeUndefined();
  });

  it('rejects empty, uppercase and path-like names', () => {
    expect(validateProjectName('')).toBeDefined();
    expect(validateProjectName('MyBot')).toBeDefined();
    expect(validateProjectName('../bot')).toBeDefined();
  });
});

describe('initSpec', () => {
  it('is the channels preset of create-cogitator-app with the answers', () => {
    expect(initSpec(answers({ channels: ['telegram', 'webchat'] }), 'npm')).toEqual({
      name: 'my-assistant',
      preset: 'channels',
      app: 'channels',
      channels: ['telegram', 'webchat'],
      memory: 'sqlite',
      features: [],
      provider: 'openai',
      model: 'gpt-6.1-sol',
      packageManager: 'npm',
    });
  });

  it('plans a valid project for every memory and provider init offers', () => {
    for (const memory of ['sqlite', 'memory', 'postgres'] as const) {
      for (const provider of ['openai', 'anthropic', 'google', 'ollama'] as const) {
        const plan = planProject(
          initSpec(answers({ memory, provider, model: `${provider}/m` }), 'pnpm')
        );
        const paths = plan.files.map((file) => file.path);
        expect(paths).toEqual(expect.arrayContaining(['src/index.ts', 'src/gateway.ts']));
      }
    }
  });
});

describe('initSecrets', () => {
  it('writes the provider key and every channel token', () => {
    expect(
      initSecrets(
        answers({
          channels: ['telegram', 'discord', 'slack'],
          telegramToken: 't',
          discordToken: 'd',
          slackToken: 'xoxb',
          slackSigningSecret: 's',
          slackAppToken: 'xapp',
        })
      )
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
      TELEGRAM_BOT_TOKEN: 't',
      DISCORD_BOT_TOKEN: 'd',
      SLACK_BOT_TOKEN: 'xoxb',
      SLACK_SIGNING_SECRET: 's',
      SLACK_APP_TOKEN: 'xapp',
    });
  });

  it('writes the Bluesky handle and app password and the Threads token', () => {
    expect(
      initSecrets(
        answers({
          channels: ['bluesky', 'threads'],
          blueskyHandle: 'bot.bsky.social',
          blueskyAppPassword: 'app-pass',
          threadsAccessToken: 'th-token',
        })
      )
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
      BLUESKY_HANDLE: 'bot.bsky.social',
      BLUESKY_APP_PASSWORD: 'app-pass',
      THREADS_ACCESS_TOKEN: 'th-token',
    });
  });

  it('writes DATABASE_URL only when it differs from the compose default', () => {
    expect(initSecrets(answers({ memory: 'postgres', databaseUrl: DEFAULT_POSTGRES_URL }))).toEqual(
      {
        OPENAI_API_KEY: 'sk-test',
      }
    );
    expect(
      initSecrets(answers({ memory: 'postgres', databaseUrl: 'postgres://db.internal/app' }))
    ).toMatchObject({ DATABASE_URL: 'postgres://db.internal/app' });
  });

  it('writes no key for Ollama', () => {
    expect(initSecrets(answers({ provider: 'ollama', apiKey: '' }))).toEqual({});
  });
});

describe('cogitator init telemetry', () => {
  it('can be turned off with --no-telemetry', async () => {
    const { initCommand } = await import('../commands/init.js');
    expect(initCommand.options.map((option) => option.long)).toContain('--no-telemetry');
  });
});
