import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import { createCogitatorRunner, type CogitatorRunnerRunOptions } from '../cogitator-runner';
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

describe('createCogitatorRunner streaming and tools', () => {
  const agent = { instructions: 'Be brief.' };

  it('runs a streamed turn with stream: true and yields each token', async () => {
    const run = vi.fn(async (_agent: unknown, options: CogitatorRunnerRunOptions) => {
      options.onToken?.('Hel');
      options.onToken?.('lo.');
      return { output: 'Hello.' };
    });
    const runner = createCogitatorRunner({ run }, agent);
    const controller = new AbortController();

    const deltas: string[] = [];
    for await (const delta of runner.stream!('Hi', {
      sessionId: 'abc',
      signal: controller.signal,
    })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual(['Hel', 'lo.']);
    expect(run).toHaveBeenCalledWith(agent, {
      input: 'Hi',
      threadId: 'voice:abc',
      signal: expect.any(AbortSignal),
      stream: true,
      onToken: expect.any(Function),
      onModelTurn: expect.any(Function),
      onMemoryEntry: expect.any(Function),
    });
  });

  it('yields the output at once from a runtime that does not stream', async () => {
    const runner = createCogitatorRunner(
      { run: vi.fn().mockResolvedValue({ output: 'All.' }) },
      agent
    );
    const deltas: string[] = [];
    for await (const delta of runner.stream!('Hi', { sessionId: 'a' })) deltas.push(delta);
    expect(deltas).toEqual(['All.']);
  });

  it('throws the run error from the stream without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const runner = createCogitatorRunner(
        { run: vi.fn().mockRejectedValue(new Error('model down')) },
        agent
      );
      const turn = runner.stream!('Hi', { sessionId: 'a' });
      const iterator = turn[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow('model down');
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      await turn.settle!({ spoken: '', interrupted: true });
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('aborts the run when the turn is interrupted', async () => {
    let runSignal: AbortSignal | undefined;
    const run = vi.fn(
      (_agent: unknown, options: CogitatorRunnerRunOptions) =>
        new Promise<{ output: string }>((_resolve, reject) => {
          runSignal = options.signal;
          options.signal?.addEventListener('abort', () => {
            const reason: unknown = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          });
        })
    );
    const runner = createCogitatorRunner({ run }, agent);
    const controller = new AbortController();
    const iterator = runner.stream!('Hi', { sessionId: 'a', signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();

    controller.abort(new Error('interrupted'));

    await expect(pending).rejects.toThrow('interrupted');
    expect(runSignal?.aborted).toBe(true);
  });

  it('offers the agent tools through invokeTool with the session thread', async () => {
    const invokeTool = vi.fn().mockResolvedValue({ result: { ok: true } });
    const weather = tool({
      name: 'weather',
      description: 'Weather',
      parameters: z.object({ city: z.string() }),
      execute: async () => ({ ok: true }),
    });
    const runner = createCogitatorRunner(
      { run: vi.fn(), invokeTool },
      { instructions: 'x', id: 'agent-1', tools: [weather] },
      { threadId: ({ sessionId }) => `user-${sessionId}` }
    );

    const tools = runner.realtimeTools!({ userId: 'u1' });
    expect(tools.map((t) => t.name)).toEqual(['weather']);
    const signal = new AbortController().signal;
    await expect(
      tools[0]!.execute({ city: 'Paris' }, { callId: 'c1', signal, sessionId: '7' })
    ).resolves.toEqual({
      ok: true,
    });
    expect(invokeTool).toHaveBeenCalledWith(
      weather,
      { city: 'Paris' },
      {
        toolCallId: 'c1',
        agentId: 'agent-1',
        signal,
        threadId: 'user-7',
        userId: 'u1',
      }
    );
  });

  it('offers no realtime tools without invokeTool', () => {
    expect(createCogitatorRunner({ run: vi.fn() }, agent).realtimeTools).toBeUndefined();
  });
});

describe('VERSION', () => {
  it('matches package.json', () => {
    expect(VERSION).toBe(packageJson.version);
  });
});
