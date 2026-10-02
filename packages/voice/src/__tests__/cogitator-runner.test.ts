import { describe, it, expect, vi } from 'vitest';
import { createCogitatorRunner } from '../cogitator-runner';
import { VERSION } from '../index';
import packageJson from '../../package.json' with { type: 'json' };

describe('createCogitatorRunner', () => {
  const agent = { instructions: 'Be brief.' };

  it('runs the agent through the runtime and maps output to content', async () => {
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'Hi!' }) };
    const runner = createCogitatorRunner(cogitator, agent);

    await expect(runner.run('Hello')).resolves.toEqual({ content: 'Hi!' });
    expect(cogitator.run).toHaveBeenCalledWith(agent, { input: 'Hello' });
  });

  it('uses a per-session thread id and forwards the abort signal', async () => {
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const runner = createCogitatorRunner(cogitator, agent);
    const controller = new AbortController();

    await runner.run('Hello', { sessionId: 'abc', signal: controller.signal });

    expect(cogitator.run).toHaveBeenCalledWith(agent, {
      input: 'Hello',
      threadId: 'voice:abc',
      signal: controller.signal,
    });
  });

  it('supports a custom thread id resolver', async () => {
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const runner = createCogitatorRunner(cogitator, agent, {
      threadId: ({ sessionId }) => `user-${sessionId}`,
    });

    await runner.run('Hello', { sessionId: '7' });
    expect(cogitator.run).toHaveBeenCalledWith(agent, { input: 'Hello', threadId: 'user-7' });
  });

  it('exposes the agent instructions for realtime mode', () => {
    const runner = createCogitatorRunner({ run: vi.fn() }, agent);
    expect(runner.instructions).toBe('Be brief.');
  });
});

describe('VERSION', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(packageJson.version);
  });
});
