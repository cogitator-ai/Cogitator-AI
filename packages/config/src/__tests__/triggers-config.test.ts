import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config';

describe('experimental_triggers', () => {
  const path = 'test-triggers-config.yaml';

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('keeps routines and limits through a YAML file', () => {
    writeFileSync(
      path,
      `
experimental_triggers:
  pollInterval: 500
  maxQueued: 3
  routines:
    - id: digest
      prompt: Summarize the news
      target: { agent: assistant }
      overlap: queue
      catchUp: none
      triggers:
        - { kind: cron, cron: '0 9 * * 1-5', timezone: Europe/Moscow }
        - { kind: github, secret: { env: GITHUB_WEBHOOK_SECRET }, events: [pull_request.opened] }
`
    );
    const config = loadConfig({ configPath: path, skipEnv: true });
    expect(config.experimental_triggers).toEqual({
      pollInterval: 500,
      maxQueued: 3,
      routines: [
        {
          id: 'digest',
          prompt: 'Summarize the news',
          target: { agent: 'assistant' },
          overlap: 'queue',
          catchUp: 'none',
          triggers: [
            { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Europe/Moscow' },
            {
              kind: 'github',
              secret: { env: 'GITHUB_WEBHOOK_SECRET' },
              events: ['pull_request.opened'],
            },
          ],
        },
      ],
    });
  });

  it('refuses a trigger of a kind it does not know', () => {
    writeFileSync(
      path,
      `
experimental_triggers:
  routines:
    - { id: x, prompt: p, target: { agent: a }, triggers: [{ kind: telepathy }] }
`
    );
    expect(() => loadConfig({ configPath: path, skipEnv: true })).toThrow();
  });
});
