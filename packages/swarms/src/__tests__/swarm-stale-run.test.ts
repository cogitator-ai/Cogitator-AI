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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a timed-out swarm run', () => {
  it('launches no further agents once it has rejected', async () => {
    const { cogitator, run } = mockCogitator(async (agent) => {
      if (agent.name === 'writer') await sleep(60);
      return createMockRunResult(`${agent.name} done`);
    });
    const swarm = new Swarm(cogitator, {
      name: 'stale-pipeline',
      strategy: 'pipeline',
      stages: [
        { name: 'draft', agent: createMockAgent('writer') },
        { name: 'review', agent: createMockAgent('editor') },
      ],
    });

    await expect(swarm.run({ input: 'go', timeout: 20 })).rejects.toBeInstanceOf(SwarmTimeoutError);
    await sleep(100);

    expect(run.mock.calls.map(([agent]) => agent.name)).toEqual(['writer']);
  });

  it('does not retry the aborted agent turn', async () => {
    const { cogitator, run } = mockCogitator(
      (_agent, options) =>
        new Promise<RunResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const swarm = new Swarm(cogitator, {
      name: 'stale-retry',
      strategy: 'round-robin',
      agents: [createMockAgent('a')],
      errorHandling: {
        onAgentFailure: 'retry',
        retry: { maxRetries: 3, backoff: 'constant', initialDelay: 1 },
      },
    });

    await expect(swarm.run({ input: 'go', timeout: 20 })).rejects.toBeInstanceOf(SwarmTimeoutError);
    await sleep(50);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cannot launch agents into the next run of the same swarm', async () => {
    const { cogitator, run } = mockCogitator(async (agent, options) => {
      if (agent.name !== 'writer') return createMockRunResult('reviewed');
      if (options.input.includes('slow')) await sleep(60);
      return createMockRunResult(options.input.includes('slow') ? 'slow draft' : 'fast draft');
    });
    const swarm = new Swarm(cogitator, {
      name: 'stale-next-run',
      strategy: 'pipeline',
      stages: [
        { name: 'draft', agent: createMockAgent('writer') },
        { name: 'review', agent: createMockAgent('editor') },
      ],
    });

    await expect(swarm.run({ input: 'slow', timeout: 20 })).rejects.toBeInstanceOf(
      SwarmTimeoutError
    );
    const next = swarm.run({ input: 'fast' });
    await sleep(100);
    await next;

    const editorInputs = run.mock.calls
      .filter(([agent]) => agent.name === 'editor')
      .map(([, options]) => options.input);
    expect(editorInputs).toHaveLength(1);
    expect(editorInputs[0]).toContain('fast draft');
  });
});
