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

  it('does not abort at once when the timeout is beyond what a timer can hold', async () => {
    const { cogitator } = mockCogitator(
      () => new Promise((resolve) => setTimeout(() => resolve(createMockRunResult('ok')), 10))
    );
    const swarm = roundRobin(cogitator);

    const result = await swarm.run({ input: 'go', timeout: 3_000_000_000 });

    expect(result.output).toBe('ok');
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

describe('Swarm pipeline stages', () => {
  it('runs a pipeline configured with the top-level stages field', async () => {
    const { cogitator, run } = instant();
    const swarm = new Swarm(cogitator, {
      name: 'stages-swarm',
      strategy: 'pipeline',
      stages: [
        { name: 'draft', agent: createMockAgent('writer') },
        { name: 'review', agent: createMockAgent('editor') },
      ],
    });

    const result = await swarm.run({ input: 'write a haiku' });

    expect(run.mock.calls.map(([agent]) => agent.name)).toEqual(['writer', 'editor']);
    expect(result.output).toBe('editor done');
  });

  it('rejects different stages in both stages and pipeline.stages', () => {
    const { cogitator } = instant();

    expect(
      () =>
        new Swarm(cogitator, {
          name: 'twice',
          strategy: 'pipeline',
          stages: [{ name: 'draft', agent: createMockAgent('writer') }],
          pipeline: { stages: [{ name: 'review', agent: createMockAgent('editor') }] },
        })
    ).toThrow('configured twice');
  });
});

describe('Swarm communication typing', () => {
  it('exposes the event history queries and read tracking of its communication', async () => {
    const { cogitator } = instant();
    const swarm = roundRobin(cogitator, ['a', 'b']);

    await swarm.run({ input: 'go' });
    const message = await swarm.messageBus.send({
      swarmId: swarm.id,
      from: 'a',
      to: 'b',
      type: 'notification',
      content: 'ping',
    });
    swarm.messageBus.markAsRead('b', [message.id]);

    expect(swarm.events.getEventsByType('swarm:complete')).toHaveLength(1);
    expect(swarm.events.getEventsByAgent('a').map((e) => e.type)).toContain('agent:complete');
    expect(swarm.messageBus.getUnreadMessages('b')).toEqual([]);
  });
});

describe('Swarm negotiation approvals', () => {
  const negotiation = (cogitator: Cogitator) =>
    new Swarm(cogitator, {
      name: 'deal',
      strategy: 'negotiation',
      agents: [createMockAgent('buyer'), createMockAgent('seller')],
      negotiation: {
        maxRounds: 1,
        onDeadlock: 'escalate',
        approvalGates: [{ trigger: 'deadlock' }],
      },
    });

  it('waits for an approval without timeout until it is answered through the swarm', async () => {
    const { cogitator } = instant();
    const swarm = negotiation(cogitator);
    const escalations: unknown[] = [];
    swarm.on('negotiation:escalation', (event) => {
      escalations.push(event.data);
    });
    swarm.on('negotiation:approval-required', (event) => {
      const { request } = event.data as { request: { id: string } };
      setTimeout(() => {
        swarm.respondToApproval(request.id, {
          requestId: request.id,
          decision: 'approved',
          approved: true,
          respondedBy: 'cfo',
          respondedAt: Date.now(),
          continueNegotiation: false,
          suggestedModifications: [
            { termId: 'price', label: 'Price', value: 100, negotiable: true, priority: 1 },
          ],
        });
      }, 5);
    });
    const received = vi.fn();
    swarm.on('negotiation:approval-received', received);

    const result = await swarm.run({ input: 'agree on a price' });

    expect(result.negotiationResult?.outcome).toBe('escalated');
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'cfo' }));
    expect(escalations).toContainEqual(
      expect.objectContaining({ reason: 'authority_modifications', respondedBy: 'cfo' })
    );
  });

  it('stops waiting for approvals when the run times out', async () => {
    const { cogitator } = instant();
    const swarm = negotiation(cogitator);

    await expect(swarm.run({ input: 'agree on a price', timeout: 50 })).rejects.toBeInstanceOf(
      SwarmTimeoutError
    );
  });

  it('refuses approval answers for swarms without negotiation', () => {
    const { cogitator } = instant();
    const swarm = roundRobin(cogitator);

    expect(() =>
      swarm.respondToApproval('approval_x', {
        requestId: 'approval_x',
        decision: 'approved',
        approved: true,
        respondedBy: 'cfo',
        respondedAt: Date.now(),
        continueNegotiation: false,
      })
    ).toThrow('has no approvals');
  });
});

describe('Swarm assessment', () => {
  it('only offers cloud models the Cogitator has a configured provider for', async () => {
    const run = vi.fn(async () => createMockRunResult('ok'));
    const route = (model: string) => {
      if (!model.startsWith('google/')) throw new Error('API key is required');
      return { model };
    };
    const cogitator = { run, route, resolveModel: () => 'ollama/test' } as unknown as Cogitator;
    const swarm = new Swarm(
      cogitator,
      { name: 'assessed', strategy: 'round-robin', agents: [createMockAgent('a')] },
      { enabledProviders: ['openai', 'anthropic', 'google'] }
    );

    const assessment = await swarm.dryRun({ input: 'Summarize the report' });

    expect(assessment.discoveredModels.length).toBeGreaterThan(0);
    expect(assessment.discoveredModels.every((m) => m.provider === 'google')).toBe(true);
  });
});
