import { describe, it, expect, vi } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { Agent, RunOptions, RunResult } from '@cogitator-ai/types';
import { Swarm, SwarmTimeoutError } from '../swarm';
import { createMockAgent, createMockRunResult } from './strategies/__mocks__/mock-helpers';

function mockCogitator(handler: (agent: Agent, options: RunOptions) => Promise<RunResult>) {
  const run = vi.fn(handler);
  const resolveModel = (agent: Agent) => agent.model ?? 'ollama/test';
  return { cogitator: { run, resolveModel } as unknown as Cogitator, run };
}

const instant = () => mockCogitator(async (agent) => createMockRunResult(`${agent.name} done`));

function roundRobin(cogitator: Cogitator, names = ['a']) {
  return new Swarm(cogitator, {
    name: 'run-swarm',
    strategy: 'round-robin',
    agents: names.map((n) => createMockAgent(n)),
  });
}

describe('Swarm.run', () => {
  it('rejects with SwarmTimeoutError when the run exceeds its timeout and can run again', async () => {
    const { cogitator } = mockCogitator(
      (_agent, options) =>
        new Promise<RunResult>((resolve, reject) => {
          if (options.input === 'quick') {
            resolve(createMockRunResult('quick'));
            return;
          }
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const swarm = roundRobin(cogitator);

    await expect(swarm.run({ input: 'slow', timeout: 20 })).rejects.toBeInstanceOf(
      SwarmTimeoutError
    );
    expect(swarm.isAborted()).toBe(false);

    const result = await swarm.run({ input: 'quick' });
    expect(result.output).toBe('quick');
  });

  it('refuses concurrent runs on the same instance', async () => {
    const { cogitator } = mockCogitator(
      () => new Promise((resolve) => setTimeout(() => resolve(createMockRunResult('ok')), 10))
    );
    const swarm = roundRobin(cogitator);

    const first = swarm.run({ input: 'one' });
    await expect(swarm.run({ input: 'two' })).rejects.toThrow('is already running');
    await expect(first).resolves.toBeDefined();
  });

  it('invokes run callbacks for agent lifecycle, events and messages', async () => {
    let swarm!: Swarm;
    const { cogitator } = mockCogitator(async (agent) => {
      await swarm.messageBus.send({
        swarmId: swarm.id,
        from: agent.name,
        to: 'broadcast',
        type: 'notification',
        content: 'hello team',
      });
      return createMockRunResult('done');
    });
    swarm = roundRobin(cogitator, ['a', 'b']);

    const onAgentStart = vi.fn();
    const onAgentComplete = vi.fn();
    const onEvent = vi.fn();
    const onMessage = vi.fn();

    await swarm.run({ input: 'go', onAgentStart, onAgentComplete, onEvent, onMessage });

    expect(onAgentStart).toHaveBeenCalledWith('a');
    expect(onAgentComplete).toHaveBeenCalledWith('a', expect.objectContaining({ output: 'done' }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'swarm:start' }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello team' }));

    onEvent.mockClear();
    await swarm.run({ input: 'again' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reports agent errors through onAgentError', async () => {
    const { cogitator } = mockCogitator(async () => {
      throw new Error('model offline');
    });
    const swarm = roundRobin(cogitator);
    const onAgentError = vi.fn();

    await expect(swarm.run({ input: 'go', onAgentError })).rejects.toThrow('model offline');
    expect(onAgentError).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ message: 'model offline' })
    );
  });

  it('passes threadId through to agent runs', async () => {
    const { cogitator, run } = instant();
    const swarm = roundRobin(cogitator);

    await swarm.run({ input: 'go', threadId: 'conversation-7' });

    expect(run.mock.calls[0][1].threadId).toBe('conversation-7:a');
  });

  it('runs every agent for the user the swarm acts for', async () => {
    const { cogitator, run } = instant();
    const swarm = roundRobin(cogitator);

    await swarm.run({ input: 'go', threadId: 'conversation-7', userId: 'alice' });
    await swarm.run({ input: 'go', threadId: 'conversation-8' });

    expect(run.mock.calls[0][1]).toMatchObject({ threadId: 'conversation-7:a', userId: 'alice' });
    expect(run.mock.calls[1][1]).not.toHaveProperty('userId');
  });
});

describe('Swarm subscriptions', () => {
  it('stops delivering events after unsubscribe', async () => {
    const { cogitator } = instant();
    const swarm = roundRobin(cogitator);
    const handler = vi.fn();

    const unsubscribe = swarm.on('swarm:complete', handler);
    await swarm.run({ input: 'one' });
    unsubscribe();
    await swarm.run({ input: 'two' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('delivers once-handlers a single time', async () => {
    const { cogitator } = instant();
    const swarm = roundRobin(cogitator);
    const handler = vi.fn();

    swarm.once('swarm:complete', handler);
    await swarm.run({ input: 'one' });
    await swarm.run({ input: 'two' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps subscriptions when the coordinator is rebuilt after assessment', async () => {
    const { cogitator } = instant();
    const swarm = new Swarm(
      cogitator,
      { name: 'assessed', strategy: 'round-robin', agents: [createMockAgent('a')] },
      { enabledProviders: [], preferLocal: false }
    );
    const complete = vi.fn();
    const once = vi.fn();
    swarm.on('swarm:complete', complete);
    swarm.once('swarm:start', once);

    await swarm.run({ input: 'one' });
    await swarm.run({ input: 'two' });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(once).toHaveBeenCalledTimes(1);
  });
});
