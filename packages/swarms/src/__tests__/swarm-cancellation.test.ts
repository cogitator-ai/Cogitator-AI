import { describe, it, expect, vi } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { Agent, RunOptions, RunResult } from '@cogitator-ai/types';
import { WorkflowBuilder, WorkflowExecutor } from '@cogitator-ai/workflows';
import { Swarm } from '../swarm';
import { swarmNode, parallelSwarmsNode } from '../workflow/swarm-node';
import { createMockAgent, createMockRunResult } from './strategies/__mocks__/mock-helpers';

function mockCogitator(handler: (agent: Agent, options: RunOptions) => Promise<RunResult>) {
  const run = vi.fn(handler);
  const resolveModel = (agent: Agent) => agent.model ?? 'ollama/test';
  return { cogitator: { run, resolveModel } as unknown as Cogitator, run };
}

/** An agent run that lasts until its signal aborts, or `ms`. */
function hangingRun(ms = 5000) {
  const signals: AbortSignal[] = [];
  const handler = (_agent: Agent, options: RunOptions) =>
    new Promise<RunResult>((resolve, reject) => {
      if (options.signal) signals.push(options.signal);
      const timer = setTimeout(() => resolve(createMockRunResult('late answer')), ms);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
  return { signals, handler };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Swarm.run signal', () => {
  it('stops the run and its agent turns when the caller aborts', async () => {
    const { signals, handler } = hangingRun();
    const { cogitator } = mockCogitator(handler);
    const swarm = new Swarm(cogitator, {
      name: 'cancellable',
      strategy: 'round-robin',
      agents: [createMockAgent('a')],
    });
    const controller = new AbortController();

    const running = swarm.run({ input: 'go', signal: controller.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort(new Error('caller gave up'));

    await expect(running).rejects.toThrow('caller gave up');
    expect(signals[0].aborted).toBe(true);
  });

  it('does not start when the signal is already aborted', async () => {
    const { cogitator, run } = mockCogitator(async () => createMockRunResult('x'));
    const swarm = new Swarm(cogitator, {
      name: 'never',
      strategy: 'round-robin',
      agents: [createMockAgent('a')],
    });

    await expect(
      swarm.run({ input: 'go', signal: AbortSignal.abort(new Error('too late')) })
    ).rejects.toThrow('too late');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('swarmNode in a workflow', () => {
  it('aborts the swarm on a node timeout so the retry can run it again', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const { cogitator } = mockCogitator((agent, options) => {
      calls++;
      if (options.signal) signals.push(options.signal);
      if (calls === 1) return hangingRun().handler(agent, options);
      return Promise.resolve(createMockRunResult('second try'));
    });
    const swarm = new Swarm(cogitator, {
      name: 's',
      strategy: 'round-robin',
      agents: [createMockAgent('a')],
    });
    const workflow = new WorkflowBuilder('with-swarm')
      .addNode('team', swarmNode(swarm), { config: { timeout: 50, retries: 1 } })
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(result.nodeResults.get('team')?.output).toBe('second try');
    expect(signals[0].aborted).toBe(true);
  });

  it('stops the swarm when the workflow run is cancelled', async () => {
    const { signals, handler } = hangingRun(300);
    const { cogitator, run } = mockCogitator(handler);
    const workflow = new WorkflowBuilder('cancelled')
      .addNode(
        'team',
        swarmNode({
          name: 'owned',
          strategy: 'pipeline',
          stages: [
            { name: 'one', agent: createMockAgent('one') },
            { name: 'two', agent: createMockAgent('two') },
          ],
        })
      )
      .build();
    const controller = new AbortController();

    const running = new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        signal: controller.signal,
      }
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort(new Error('cancelled'));
    const result = await running;
    await sleep(350);

    expect(result.error).toBeDefined();
    expect(signals[0].aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes the run signal to every swarm of a parallel node', async () => {
    const { signals, handler } = hangingRun();
    const { cogitator } = mockCogitator(handler);
    const workflow = new WorkflowBuilder('parallel')
      .addNode(
        'teams',
        parallelSwarmsNode([
          {
            key: 'x',
            swarm: { name: 'x', strategy: 'round-robin', agents: [createMockAgent('x')] },
          },
          {
            key: 'y',
            swarm: { name: 'y', strategy: 'round-robin', agents: [createMockAgent('y')] },
          },
        ])
      )
      .build();
    const controller = new AbortController();

    const running = new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        signal: controller.signal,
      }
    );
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    controller.abort(new Error('cancelled'));
    const result = await running;

    expect(result.error).toBeDefined();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
