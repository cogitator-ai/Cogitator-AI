import { describe, it, expect, vi } from 'vitest';
import { Agent as CoreAgent, getLogger } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import type { Agent, RunOptions, RunResult, SwarmConfig, ToolContext } from '@cogitator-ai/types';
import { SwarmCoordinator } from '../coordinator';
import { Swarm } from '../swarm';
import { createMockAgent, createMockRunResult } from './strategies/__mocks__/mock-helpers';

type RunHandler = (agent: Agent, options: RunOptions) => Promise<RunResult> | RunResult;

function mockCogitator(handler: RunHandler) {
  const run = vi.fn(async (agent: Agent, options: RunOptions) => handler(agent, options));
  return { cogitator: { run } as unknown as Cogitator, run };
}

function config(overrides: Partial<SwarmConfig>): SwarmConfig {
  return { name: 'recovery-swarm', strategy: 'round-robin', ...overrides };
}

describe('SwarmCoordinator error recovery', () => {
  it('retries a failing agent exactly maxRetries times without recursing', async () => {
    const { cogitator, run } = mockCogitator(() => {
      throw new Error('model unavailable');
    });
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('flaky')],
        errorHandling: {
          onAgentFailure: 'retry',
          retry: { maxRetries: 2, backoff: 'constant', initialDelay: 1 },
        },
      })
    );

    await expect(coord.runAgent('flaky', 'go')).rejects.toThrow(
      "Agent 'flaky' failed after 2 retries: model unavailable"
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('returns the first successful retry', async () => {
    let calls = 0;
    const { cogitator, run } = mockCogitator(() => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return createMockRunResult('recovered');
    });
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('flaky')],
        errorHandling: {
          onAgentFailure: 'retry',
          retry: { maxRetries: 3, backoff: 'exponential', initialDelay: 1 },
        },
      })
    );

    const result = await coord.runAgent('flaky', 'go');
    expect(result.output).toBe('recovered');
    expect(run).toHaveBeenCalledTimes(2);
    expect(coord.getAgent('flaky')!.state).toBe('completed');
  });

  it('does not retry once the swarm is aborted', async () => {
    let coord!: SwarmCoordinator;
    const { cogitator, run } = mockCogitator(() => {
      coord.abort();
      throw new Error('boom');
    });
    coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('a')],
        errorHandling: {
          onAgentFailure: 'retry',
          retry: { maxRetries: 5, backoff: 'constant', initialDelay: 20 },
        },
      })
    );

    await expect(coord.runAgent('a', 'go')).rejects.toThrow('boom');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels in-flight runs through the abort signal', async () => {
    const { cogitator } = mockCogitator(
      (_agent, options) =>
        new Promise<RunResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('cancelled by signal')));
        })
    );
    const coord = new SwarmCoordinator(cogitator, config({ agents: [createMockAgent('slow')] }));

    const pending = coord.runAgent('slow', 'go');
    await new Promise((r) => setTimeout(r, 5));
    coord.abort();

    await expect(pending).rejects.toThrow('cancelled by signal');
    expect(coord.isAborted()).toBe(true);

    coord.reset();
    expect(coord.isAborted()).toBe(false);
  });

  it('cancels runs when the run-scoped signal aborts and recovers for the next run', async () => {
    const { cogitator } = mockCogitator(
      (_agent, options) =>
        new Promise<RunResult>((resolve, reject) => {
          if (options.input === 'fast') {
            resolve(createMockRunResult('fast done'));
            return;
          }
          options.signal?.addEventListener('abort', () => reject(new Error('run cancelled')));
        })
    );
    const coord = new SwarmCoordinator(cogitator, config({ agents: [createMockAgent('a')] }));

    const controller = new AbortController();
    coord.beginRun({ signal: controller.signal });
    const pending = coord.runAgent('a', 'slow');
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toThrow('run cancelled');
    coord.endRun();

    coord.beginRun({});
    await expect(coord.runAgent('a', 'fast')).resolves.toMatchObject({ output: 'fast done' });
    expect(coord.isAborted()).toBe(false);
  });

  it('fails over along the configured chain without looping', async () => {
    const { cogitator } = mockCogitator((agent) => {
      if (agent.name === 'backup') return createMockRunResult('from backup');
      throw new Error(`${agent.name} down`);
    });
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('primary'), createMockAgent('backup')],
        errorHandling: { onAgentFailure: 'failover', failover: { primary: 'backup' } },
      })
    );

    const result = await coord.runAgent('primary', 'go');
    expect(result.output).toBe('from backup');
  });
});

describe('SwarmCoordinator run scope and limits', () => {
  it('derives a per-agent thread id from the run thread id', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(cogitator, config({ agents: [createMockAgent('a')] }));

    coord.beginRun({ threadId: 'thread-1' });
    await coord.runAgent('a', 'go');

    expect(run.mock.calls[0][1].threadId).toBe('thread-1:a');
  });

  it('restarts resource budgets for every run', async () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(
      cogitator,
      config({ agents: [createMockAgent('a')], resources: { tokenBudget: 200 } })
    );

    coord.beginRun({});
    await coord.runAgent('a', 'go');
    await coord.runAgent('a', 'go');
    await expect(coord.runAgent('a', 'go')).rejects.toThrow('Swarm resource budget exceeded');

    coord.beginRun({});
    await expect(coord.runAgent('a', 'go')).resolves.toBeDefined();
  });

  it('applies resources.perAgent limits by running a capped clone', async () => {
    const agent = new CoreAgent({
      name: 'capped',
      model: 'ollama/test',
      instructions: 'x',
      maxTokens: 4000,
      maxIterations: 20,
    });
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [agent],
        resources: { perAgent: { maxTokens: 500, maxIterations: 3, timeout: 1234 } },
      })
    );

    await coord.runAgent('capped', 'go');

    const [runAgent, options] = run.mock.calls[0];
    expect(runAgent).not.toBe(agent);
    expect(runAgent.name).toBe('capped');
    expect(runAgent.config.maxTokens).toBe(500);
    expect(runAgent.config.maxIterations).toBe(3);
    expect(options.timeout).toBe(1234);
    expect(coord.getAgent('capped')!.agent).toBe(agent);
  });

  it('applies per-turn token and timeout caps', async () => {
    const agent = new CoreAgent({ name: 'turn', model: 'ollama/test', instructions: 'x' });
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(cogitator, config({ agents: [agent] }));

    await coord.runAgent('turn', 'go', undefined, { maxTokens: 64, timeout: 50 });
    await coord.runAgent('turn', 'go');

    expect(run.mock.calls[0][0].config.maxTokens).toBe(64);
    expect(run.mock.calls[0][1].timeout).toBe(50);
    expect(run.mock.calls[1][0]).toBe(agent);
    expect(run.mock.calls[1][1].timeout).toBeUndefined();
  });

  it('keeps at most maxConcurrency runs in flight and keeps the pool busy', async () => {
    let running = 0;
    let peak = 0;
    const finished: string[] = [];
    const { cogitator } = mockCogitator(async (agent) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, agent.name === 'a0' ? 100 : 5));
      running--;
      finished.push(agent.name);
      return createMockRunResult(agent.name);
    });
    const agents = Array.from({ length: 5 }, (_, i) => createMockAgent(`a${i}`));
    const coord = new SwarmCoordinator(cogitator, config({ agents }));

    const results = await coord.runAgentsParallel(
      agents.map((a) => ({ name: a.name, input: 'go' })),
      2
    );

    expect(results.size).toBe(5);
    expect(peak).toBe(2);
    expect(finished.at(-1)).toBe('a0');
  });

  it('returns partial results when partialResults is enabled', async () => {
    const { cogitator } = mockCogitator((agent) => {
      if (agent.name === 'bad') throw new Error('bad agent');
      return createMockRunResult('good');
    });
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('good'), createMockAgent('bad')],
        errorHandling: { onAgentFailure: 'abort', partialResults: true },
      })
    );

    const results = await coord.runAgentsParallel([
      { name: 'good', input: 'x' },
      { name: 'bad', input: 'y' },
    ]);

    expect(Array.from(results.keys())).toEqual(['good']);
  });
});

describe('SwarmCoordinator agents and messaging', () => {
  it('applies agentMetadata on top of slot defaults', () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('pro'), createMockAgent('con')],
        agentMetadata: { pro: { role: 'advocate', weight: 2 }, con: { role: 'critic' } },
      })
    );

    expect(coord.getAgent('pro')!.metadata).toMatchObject({ role: 'advocate', weight: 2 });
    expect(coord.getAgentsByRole('critic').map((a) => a.agent.name)).toEqual(['con']);
  });

  it('rejects two different agents sharing a name', () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    expect(
      () =>
        new SwarmCoordinator(
          cogitator,
          config({ agents: [createMockAgent('dup'), createMockAgent('dup')] })
        )
    ).toThrow("Duplicate agent name 'dup'");
  });

  it('delivers incoming messages to an agent only once', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(
      cogitator,
      config({ agents: [createMockAgent('a'), createMockAgent('b')] })
    );

    await coord.messageBus.send({
      swarmId: 's',
      from: 'a',
      to: 'b',
      type: 'request',
      content: 'ping',
    });

    await coord.runAgent('b', 'first');
    await coord.runAgent('b', 'second');

    const firstContext = run.mock.calls[0][1].context!;
    const secondContext = run.mock.calls[1][1].context!;
    expect(firstContext._incomingMessages).toContain('ping');
    expect(secondContext._incomingMessages).toBeUndefined();
    expect(coord.messageBus.getUnreadMessages('b')).toHaveLength(0);
  });

  it('emits message:sent events and counts messages per sender', async () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(
      cogitator,
      config({ agents: [createMockAgent('a'), createMockAgent('b')] })
    );
    const sent = vi.fn();
    coord.events.on('message:sent', sent);

    await coord.messageBus.send({
      swarmId: 's',
      from: 'a',
      to: 'b',
      type: 'request',
      content: 'hi',
    });

    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'a', data: expect.objectContaining({ content: 'hi' }) })
    );
    expect(coord.getAgent('a')!.messageCount).toBe(1);
  });

  it('emits blackboard:write events', () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(cogitator, config({ agents: [createMockAgent('a')] }));
    const writes = vi.fn();
    coord.events.on('blackboard:write', writes);

    coord.blackboard.write('plan', { step: 1 }, 'a');

    expect(writes).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ section: 'plan', version: 1 }) })
    );
  });

  it('resets per-turn message quotas at the start of every agent turn', async () => {
    let coord!: SwarmCoordinator;
    const { cogitator } = mockCogitator(async (agent) => {
      await coord.messageBus.send({
        swarmId: 's',
        from: agent.name,
        to: 'b',
        type: 'notification',
        content: 'update',
      });
      return createMockRunResult('ok');
    });
    coord = new SwarmCoordinator(
      cogitator,
      config({
        agents: [createMockAgent('a'), createMockAgent('b')],
        messaging: { enabled: true, protocol: 'direct', maxMessagesPerTurn: 1 },
      })
    );

    await coord.runAgent('a', 'turn 1');
    await expect(coord.runAgent('a', 'turn 2')).resolves.toBeDefined();
    await expect(
      coord.messageBus.send({ swarmId: 's', from: 'a', to: 'b', type: 'request', content: 'x' })
    ).rejects.toThrow('exceeded max messages per turn');
  });
});

describe('SwarmCoordinator strategy tools', () => {
  const coreAgent = (name: string, tools: CoreAgent['tools'] = []) =>
    new CoreAgent({ name, model: 'ollama/test', instructions: name, tools });

  it('equips the hierarchical supervisor with delegation tools only', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const lead = coreAgent('lead');
    const worker = coreAgent('worker');
    const coord = new SwarmCoordinator(cogitator, {
      name: 'h',
      strategy: 'hierarchical',
      supervisor: lead,
      workers: [worker],
    });

    await coord.runAgent('lead', 'plan');
    await coord.runAgent('worker', 'do');

    const supervisorTools = run.mock.calls[0][0].tools.map((t) => t.name);
    expect(supervisorTools).toEqual(
      expect.arrayContaining([
        'delegate_task',
        'check_progress',
        'request_revision',
        'list_workers',
      ])
    );
    expect(run.mock.calls[1][0]).toBe(worker);
    expect(lead.tools).toHaveLength(0);
  });

  it('gives negotiating agents the negotiation tools without duplicating existing ones', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const custom = {
      name: 'make_offer',
      description: 'custom',
    } as CoreAgent['tools'][number];
    const buyer = coreAgent('buyer', [custom]);
    const coord = new SwarmCoordinator(cogitator, {
      name: 'n',
      strategy: 'negotiation',
      agents: [buyer, coreAgent('seller')],
      negotiation: { maxRounds: 1, onDeadlock: 'fail' },
    });

    await coord.runAgent('buyer', 'go');

    const names = run.mock.calls[0][0].tools.map((t) => t.name);
    expect(names.filter((n) => n === 'make_offer')).toHaveLength(1);
    expect(run.mock.calls[0][0].tools[0]).toBe(custom);
    expect(names).toEqual(expect.arrayContaining(['accept_offer', 'declare_interests']));
  });

  const toolContext: ToolContext = {
    agentId: 'agent',
    runId: 'run',
    signal: new AbortController().signal,
  };
  const consensusConfig = {
    threshold: 0.5,
    maxRounds: 1,
    resolution: 'majority' as const,
    onNoConsensus: 'fail' as const,
  };

  it('gives consensus voters the voting tools with their configured weight', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(cogitator, {
      name: 'c',
      strategy: 'consensus',
      supervisor: coreAgent('chair'),
      agents: [coreAgent('alice'), coreAgent('bob')],
      consensus: { ...consensusConfig, weights: { alice: 3 } },
    });
    coord.blackboard.write('consensus', { currentRound: 1, votes: [] }, 'system');

    await coord.runAgent('alice', 'vote');
    await coord.runAgent('chair', 'decide');

    const aliceTools = run.mock.calls[0][0].tools;
    expect(aliceTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['cast_vote', 'get_votes', 'change_vote', 'get_consensus_status'])
    );
    const castVote = aliceTools.find((t) => t.name === 'cast_vote');
    await expect(castVote?.execute({ decision: 'ship' }, toolContext)).resolves.toMatchObject({
      success: true,
      weight: 3,
    });
    expect(run.mock.calls[1][0].tools).toHaveLength(0);
  });

  it('reaches consensus from votes cast with the cast_vote tool', async () => {
    const { cogitator } = mockCogitator(async (agent) => {
      const castVote = agent.tools.find((t) => t.name === 'cast_vote');
      await castVote?.execute({ decision: 'ship it' }, toolContext);
      return createMockRunResult('I have cast my vote.');
    });
    const swarm = new Swarm(cogitator, {
      name: 'c',
      strategy: 'consensus',
      agents: [coreAgent('alice'), coreAgent('bob')],
      consensus: consensusConfig,
    });

    const result = await swarm.run({ input: 'Release on Friday?' });

    expect(result.output).toContain('CONSENSUS REACHED');
    expect(result.output).toContain('Decision: ship it');
  });

  it('adds the messaging and blackboard tools enabled with agentTools to every agent', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const coord = new SwarmCoordinator(cogitator, {
      name: 't',
      strategy: 'round-robin',
      agents: [coreAgent('a'), coreAgent('b')],
      agentTools: { messaging: true, blackboard: true },
    });

    await coord.runAgent('a', 'go');
    const names = run.mock.calls[0][0].tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'send_message',
        'read_messages',
        'broadcast_message',
        'reply_to_message',
        'read_blackboard',
        'write_blackboard',
        'append_blackboard',
        'list_blackboard_sections',
        'get_blackboard_history',
      ])
    );

    const sendMessage = run.mock.calls[0][0].tools.find((t) => t.name === 'send_message');
    await sendMessage?.execute({ to: 'b', message: 'hello' }, toolContext);
    expect(coord.messageBus.getUnreadMessages('b')).toEqual([
      expect.objectContaining({ from: 'a', content: 'hello', swarmId: coord.getSwarmId() }),
    ]);
  });

  it('adds no built-in tools without agentTools', async () => {
    const { cogitator, run } = mockCogitator(() => createMockRunResult('ok'));
    const agent = coreAgent('a');
    const coord = new SwarmCoordinator(cogitator, {
      name: 't',
      strategy: 'round-robin',
      agents: [agent],
    });

    await coord.runAgent('a', 'go');

    expect(run.mock.calls[0][0]).toBe(agent);
  });

  it('rejects agentTools that cannot work with the swarm configuration', () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    const base = { name: 't', strategy: 'round-robin' as const, agents: [coreAgent('a')] };

    expect(
      () =>
        new Swarm(cogitator, {
          ...base,
          agentTools: { messaging: true },
          distributed: { enabled: true },
        })
    ).toThrow('not available in distributed swarms');
    expect(
      () =>
        new Swarm(cogitator, {
          ...base,
          agentTools: { messaging: true },
          messaging: { enabled: false },
        })
    ).toThrow('messaging.enabled is false');
    expect(
      () =>
        new Swarm(cogitator, {
          ...base,
          agentTools: { blackboard: true },
          blackboard: { enabled: false, sections: {} },
        })
    ).toThrow('blackboard.enabled is false');
  });
});

describe('SwarmCoordinator observability', () => {
  it('logs the trace of every agent run when tracing is enabled', async () => {
    const span = {
      id: 'span_1',
      traceId: 'trace_1',
      name: 'llm.chat',
      kind: 'client' as const,
      status: 'ok' as const,
      startTime: 0,
      endTime: 5,
      duration: 5,
      attributes: { model: 'test' },
    };
    const { cogitator } = mockCogitator(() =>
      createMockRunResult('ok', { trace: { traceId: 'trace_1', spans: [span] } })
    );
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const coord = new SwarmCoordinator(
      cogitator,
      config({ agents: [createMockAgent('a')], observability: { tracing: true } })
    );

    try {
      await coord.runAgent('a', 'go');

      expect(info).toHaveBeenCalledWith(
        '[Swarm] agent trace',
        expect.objectContaining({
          swarm: 'recovery-swarm',
          agent: 'a',
          traceId: 'trace_1',
          spans: [expect.objectContaining({ name: 'llm.chat', duration: 5 })],
        })
      );
    } finally {
      info.mockRestore();
    }
  });

  it('logs no traces when tracing is off', async () => {
    const { cogitator } = mockCogitator(() => createMockRunResult('ok'));
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const coord = new SwarmCoordinator(cogitator, config({ agents: [createMockAgent('a')] }));

    try {
      await coord.runAgent('a', 'go');
      expect(info).not.toHaveBeenCalledWith('[Swarm] agent trace', expect.anything());
    } finally {
      info.mockRestore();
    }
  });
});
