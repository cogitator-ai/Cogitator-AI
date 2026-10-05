import { describe, it, expect, beforeEach } from 'vitest';
import type { DebateConfig, ToolContext } from '@cogitator-ai/types';
import { HierarchicalStrategy } from '../../strategies/hierarchical';
import { ConsensusStrategy } from '../../strategies/consensus';
import { PipelineStrategy } from '../../strategies/pipeline';
import { DebateStrategy } from '../../strategies/debate';
import { NegotiationStrategy } from '../../strategies/negotiation-strategy';
import { createDelegationTools } from '../../tools/delegation';
import { createVotingTools } from '../../tools/voting';
import { createNegotiationTools } from '../../tools/negotiation';
import { MockCoordinator } from './__mocks__/mock-coordinator';
import {
  createMockAgent,
  createMockRunResult,
  createMockSwarmAgent,
} from './__mocks__/mock-helpers';

const toolContext: ToolContext = {
  agentId: 'agent',
  runId: 'run',
  signal: new AbortController().signal,
};

describe('HierarchicalStrategy delegation', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('boss', { role: 'supervisor' }));
    coordinator.addAgent(createMockSwarmAgent('coder', { role: 'worker' }));
    coordinator.addAgent(createMockSwarmAgent('tester', { role: 'worker' }));
    coordinator.setAgentResponse('coder', 'code written');
    coordinator.setAgentResponse('tester', 'tests written');
  });

  it('collects results of workers that ran during the supervisor turn', async () => {
    const tools = createDelegationTools(coordinator, coordinator.blackboard, 'boss');
    coordinator.setAgentResponse('boss', async () => {
      await tools.delegateTask.execute({ worker: 'coder', task: 'write code' }, toolContext);
      return 'shipped';
    });

    const result = await new HierarchicalStrategy(coordinator).execute({ input: 'build it' });

    expect(result.output).toBe('shipped');
    expect(result.agentResults.get('coder')?.output).toBe('code written');
    expect(result.agentResults.has('tester')).toBe(false);
  });

  it('refuses self-delegation and delegation to the supervisor', async () => {
    const supervisorTools = createDelegationTools(coordinator, coordinator.blackboard, 'boss');
    const workerTools = createDelegationTools(coordinator, coordinator.blackboard, 'coder');
    const outcomes: unknown[] = [];

    coordinator.setAgentResponse('boss', async () => {
      outcomes.push(
        await supervisorTools.delegateTask.execute({ worker: 'boss', task: 'loop' }, toolContext)
      );
      outcomes.push(
        await workerTools.delegateTask.execute({ worker: 'boss', task: 'up' }, toolContext)
      );
      return 'done';
    });

    await new HierarchicalStrategy(coordinator).execute({ input: 'x' });

    expect(outcomes[0]).toMatchObject({
      success: false,
      error: expect.stringContaining('yourself'),
    });
    expect(outcomes[1]).toMatchObject({
      success: false,
      error: expect.stringContaining('supervisor'),
    });
  });

  it('enforces maxDelegationDepth', async () => {
    const supervisorTools = createDelegationTools(coordinator, coordinator.blackboard, 'boss');
    const coderTools = createDelegationTools(coordinator, coordinator.blackboard, 'coder');
    let nested: unknown;

    coordinator.setAgentResponse('coder', async () => {
      nested = await coderTools.delegateTask.execute(
        { worker: 'tester', task: 'test it' },
        toolContext
      );
      return 'code';
    });
    coordinator.setAgentResponse('boss', async () => {
      await supervisorTools.delegateTask.execute({ worker: 'coder', task: 'code' }, toolContext);
      return 'done';
    });

    await new HierarchicalStrategy(coordinator, { maxDelegationDepth: 1 }).execute({ input: 'x' });

    expect(nested).toMatchObject({
      success: false,
      error: 'Maximum delegation depth (1) reached',
    });
  });

  it('hides worker output from the supervisor when visibility is none', async () => {
    const tools = createDelegationTools(coordinator, coordinator.blackboard, 'boss');
    let delegation: unknown;
    coordinator.setAgentResponse('boss', async () => {
      delegation = await tools.delegateTask.execute({ worker: 'coder', task: 'x' }, toolContext);
      return 'done';
    });

    await new HierarchicalStrategy(coordinator, { visibility: 'none' }).execute({ input: 'x' });

    expect(delegation).toMatchObject({ success: true });
    expect((delegation as { output?: string }).output).toBeUndefined();
  });
});

describe('ConsensusStrategy resolution', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  function addVoters(votes: Record<string, string>) {
    for (const [name, output] of Object.entries(votes)) {
      coordinator.addAgent(createMockSwarmAgent(name));
      coordinator.setAgentResponse(name, output);
    }
  }

  it('does not reach consensus on a tie', async () => {
    addVoters({
      a: 'VOTE: red',
      b: 'VOTE: red',
      c: 'VOTE: blue',
      d: 'VOTE: blue',
    });

    const strategy = new ConsensusStrategy(coordinator, {
      threshold: 0.5,
      maxRounds: 1,
      resolution: 'majority',
      onNoConsensus: 'escalate',
    });

    const result = await strategy.execute({ input: 'color?' });
    expect(String(result.output)).toContain('NO CONSENSUS');
  });

  it('counts abstentions against the leading decision', async () => {
    addVoters({ a: 'VOTE: yes', b: 'I am not sure', c: 'no comment' });

    const strategy = new ConsensusStrategy(coordinator, {
      threshold: 0.5,
      maxRounds: 1,
      resolution: 'majority',
      onNoConsensus: 'escalate',
    });

    const result = await strategy.execute({ input: 'ship?' });
    expect(String(result.output)).toContain('NO CONSENSUS');
  });

  it('treats formatting variants of a decision as the same vote', async () => {
    addVoters({ a: 'VOTE: **Option A**', b: 'VOTE: option a.', c: 'VOTE: B' });

    const strategy = new ConsensusStrategy(coordinator, {
      threshold: 0.6,
      maxRounds: 1,
      resolution: 'majority',
      onNoConsensus: 'fail',
    });

    const result = await strategy.execute({ input: 'pick' });
    expect(String(result.output)).toContain('CONSENSUS REACHED');
  });

  it('prefers votes cast through the voting tools over text parsing', async () => {
    for (const name of ['a', 'b']) {
      coordinator.addAgent(createMockSwarmAgent(name));
      const tools = createVotingTools(coordinator.blackboard, coordinator.events, name);
      coordinator.setAgentResponse(name, async () => {
        await tools.castVote.execute({ decision: 'postgres' }, toolContext);
        return 'VOTE: mongo';
      });
    }

    const strategy = new ConsensusStrategy(coordinator, {
      threshold: 1,
      maxRounds: 1,
      resolution: 'unanimous',
      onNoConsensus: 'fail',
    });

    const result = await strategy.execute({ input: 'database?' });
    expect(String(result.output)).toContain('Decision: postgres');

    const board = coordinator.blackboard.read<{ votes: { agentName: string }[] }>('consensus');
    expect(board.votes).toHaveLength(2);
  });
});

describe('PipelineStrategy gates', () => {
  it('re-runs the first stage when its gate fails with retry-previous', async () => {
    const coordinator = new MockCoordinator();
    const agent = createMockAgent('drafter');
    coordinator.addAgent(createMockSwarmAgent('drafter'));
    let attempts = 0;
    coordinator.setAgentResponse('drafter', () => {
      attempts++;
      return attempts < 2 ? 'bad draft' : 'good draft';
    });

    const strategy = new PipelineStrategy(coordinator, {
      stages: [{ name: 'draft', agent, gate: true }],
      gates: {
        draft: {
          condition: (output) => String(output).startsWith('good'),
          onFail: 'retry-previous',
          maxRetries: 2,
        },
      },
    });

    const result = await strategy.execute({ input: 'write' });
    expect(attempts).toBe(2);
    expect(result.output).toBe('good draft');
  });
});

describe('DebateStrategy', () => {
  it('caps debater turns with maxTokensPerTurn', async () => {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('pro', { role: 'advocate' }));
    coordinator.addAgent(createMockSwarmAgent('con', { role: 'critic' }));

    await new DebateStrategy(coordinator, { rounds: 1, maxTokensPerTurn: 128 }).execute({
      input: 'topic',
    });

    for (const call of coordinator.getCalls()) {
      expect(call.options).toEqual({ maxTokens: 128 });
    }
  });

  const turn = (
    output: string,
    outputTokens: number,
    extra: { reasoningTokens?: number; truncated?: boolean; toolCalled?: boolean } = {}
  ) =>
    createMockRunResult(output, {
      usage: {
        inputTokens: 100,
        outputTokens,
        totalTokens: 100 + outputTokens,
        cost: 0,
        duration: 10,
        ...(extra.reasoningTokens !== undefined && { reasoningTokens: extra.reasoningTokens }),
      },
      ...(extra.truncated && { truncated: true }),
      ...(extra.toolCalled && {
        toolCalls: [{ id: 'c1', name: 'search', arguments: {} }],
      }),
    });

  function debate(responses: Record<string, ReturnType<typeof turn>[]>) {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('pro', { role: 'advocate' }));
    coordinator.addAgent(createMockSwarmAgent('con', { role: 'critic' }));
    for (const [name, results] of Object.entries(responses)) {
      let call = 0;
      coordinator.setAgentResponse(name, () => results[Math.min(call++, results.length - 1)]);
    }
    return coordinator;
  }

  const limits = (coordinator: MockCoordinator, name: string) =>
    coordinator.getCallsFor(name).map((call) => call.options);

  const run = (coordinator: MockCoordinator, extra: Partial<DebateConfig> = {}) =>
    new DebateStrategy(coordinator, { rounds: 1, maxTokensPerTurn: 128, ...extra }).execute({
      input: 'topic',
    });

  it('runs again a turn a reasoning model came back from empty, with room to reason', async () => {
    const coordinator = debate({
      pro: [
        turn('', 128, { reasoningTokens: 128, truncated: true }),
        turn('The case for', 900, { reasoningTokens: 700 }),
      ],
      con: [turn('The case against', 120)],
    });

    const result = await run(coordinator);

    expect(limits(coordinator, 'pro')).toEqual([{ maxTokens: 128 }, { maxTokens: 128 + 4096 }]);
    expect(limits(coordinator, 'con')).toEqual([{ maxTokens: 128 }]);
    expect(result.output).toContain('The case for');
  });

  it('gives a turn cut off by long reasoning twice the reasoning it spent', async () => {
    const coordinator = debate({
      pro: [
        turn('The case f', 6000, { reasoningTokens: 5900, truncated: true }),
        turn('The case for', 9000, { reasoningTokens: 8800 }),
      ],
    });

    await run(coordinator);

    expect(limits(coordinator, 'pro')[1]).toEqual({ maxTokens: 128 + 5900 * 2 });
  });

  it('spots a starved turn of a provider that reports no reasoning tokens', async () => {
    const coordinator = debate({
      pro: [turn('The', 128, { truncated: true }), turn('The case for', 900)],
    });

    await run(coordinator);

    expect(limits(coordinator, 'pro')).toEqual([{ maxTokens: 128 }, { maxTokens: 128 + 4096 }]);
  });

  it('keeps the limit for a long answer of a model that does not reason', async () => {
    const coordinator = debate({ pro: [turn('word '.repeat(110), 128, { truncated: true })] });

    await run(coordinator);

    expect(limits(coordinator, 'pro')).toHaveLength(1);
  });

  it('keeps the limit for a model that does not reason, even on an empty turn', async () => {
    const coordinator = debate({ pro: [turn('', 128)] });

    await run(coordinator);

    expect(limits(coordinator, 'pro')).toHaveLength(1);
  });

  it('never runs again a turn that called tools', async () => {
    const coordinator = debate({
      pro: [turn('', 128, { reasoningTokens: 128, truncated: true, toolCalled: true })],
    });

    await run(coordinator);

    expect(limits(coordinator, 'pro')).toHaveLength(1);
  });

  it('does not take the summed output of a finished turn for a cut-off one', async () => {
    const coordinator = debate({
      pro: [turn('The case for, after a search', 5000, { reasoningTokens: 3000 })],
    });

    await run(coordinator);

    expect(limits(coordinator, 'pro')).toHaveLength(1);
  });

  it('gives reasoningTokensPerTurn from the first try', async () => {
    const coordinator = debate({ pro: [turn('The case for', 1500, { reasoningTokens: 1400 })] });

    await run(coordinator, { reasoningTokensPerTurn: 2000 });

    expect(limits(coordinator, 'pro')).toEqual([{ maxTokens: 2128 }]);
  });

  it('tells debaters how long an answer may be', async () => {
    const coordinator = debate({ pro: [turn('The case for', 100)] });

    await run(coordinator);

    const instructions = coordinator.getCallsFor('pro')[0]?.context?.debateInstructions;
    expect(instructions).toEqual(expect.stringContaining('Keep your answer within about 96 words'));
  });

  it('rejects a non-positive number of rounds', async () => {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('pro'));
    coordinator.addAgent(createMockSwarmAgent('con'));

    await expect(
      new DebateStrategy(coordinator, { rounds: 0 }).execute({ input: 't' })
    ).rejects.toThrow('at least 1 round');
  });
});

describe('NegotiationStrategy agreement flow', () => {
  const term = (value: number) => ({
    termId: 'price',
    label: 'Price',
    value,
    negotiable: true,
    priority: 5,
  });

  it('reaches agreement when the recipient accepts an offer through the tools', async () => {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('buyer'));
    coordinator.addAgent(createMockSwarmAgent('seller'));

    const buyerTools = createNegotiationTools(coordinator.blackboard, coordinator.events, 'buyer');
    const sellerTools = createNegotiationTools(
      coordinator.blackboard,
      coordinator.events,
      'seller'
    );
    let offerId: string | undefined;

    coordinator.setAgentResponse('buyer', async (input) => {
      if (input.includes('PROPOSAL') && !offerId) {
        const made = (await buyerTools.makeOffer.execute(
          { to: 'seller', terms: [term(100)], reasoning: 'fair price' },
          toolContext
        )) as { offerId?: string };
        offerId = made.offerId;
      }
      return 'ok';
    });
    coordinator.setAgentResponse('seller', async (input) => {
      if (input.includes('COUNTER') && offerId) {
        await sellerTools.acceptOffer.execute({ offerId }, toolContext);
      }
      return 'ok';
    });

    const result = await new NegotiationStrategy(coordinator, {
      maxRounds: 2,
      onDeadlock: 'fail',
      turnTimeout: 0,
    }).execute({ input: 'sell the widget' });

    expect(result.negotiationResult?.outcome).toBe('agreement');
    expect(result.negotiationResult?.agreement).toMatchObject({
      parties: ['buyer', 'seller'],
      reachedVia: 'consensus',
      terms: [expect.objectContaining({ value: 100 })],
    });
  });

  it('requires every recipient of a multi-party offer to accept', async () => {
    const coordinator = new MockCoordinator();
    for (const name of ['a', 'b', 'c']) coordinator.addAgent(createMockSwarmAgent(name));

    const tools = {
      a: createNegotiationTools(coordinator.blackboard, coordinator.events, 'a'),
      b: createNegotiationTools(coordinator.blackboard, coordinator.events, 'b'),
    };
    let offerId: string | undefined;

    coordinator.setAgentResponse('a', async (input) => {
      if (input.includes('PROPOSAL') && !offerId) {
        const made = (await tools.a.makeOffer.execute(
          { to: ['b', 'c'], terms: [term(10)], reasoning: 'split' },
          toolContext
        )) as { offerId?: string };
        offerId = made.offerId;
      }
      return 'ok';
    });
    coordinator.setAgentResponse('b', async (input) => {
      if (input.includes('COUNTER') && offerId) {
        await tools.b.acceptOffer.execute({ offerId }, toolContext);
      }
      return 'ok';
    });
    coordinator.setAgentResponse('c', 'thinking');

    const result = await new NegotiationStrategy(coordinator, {
      maxRounds: 1,
      onDeadlock: 'fail',
      turnTimeout: 0,
    }).execute({ input: 'split costs' });

    expect(result.negotiationResult?.outcome).toBe('deadlock');
    const offer = result.negotiationResult?.offers.find((o) => o.id === offerId);
    expect(offer?.status).toBe('pending');
  });

  it('publishes rules that the tools enforce', async () => {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('a'));
    coordinator.addAgent(createMockSwarmAgent('b'));
    const tools = createNegotiationTools(coordinator.blackboard, coordinator.events, 'a');
    const outcomes: unknown[] = [];

    coordinator.setAgentResponse('a', async (input) => {
      if (input.includes('PROPOSAL')) {
        for (let i = 0; i < 2; i++) {
          outcomes.push(
            await tools.makeOffer.execute(
              { to: 'b', terms: [term(i)], reasoning: 'try' },
              toolContext
            )
          );
        }
        outcomes.push(
          await tools.proposeCoalition.execute(
            { name: 'team', invitees: ['b'], sharedInterests: [], reasoning: 'x' },
            toolContext
          )
        );
      }
      return 'ok';
    });
    coordinator.setAgentResponse('b', 'ok');

    await new NegotiationStrategy(coordinator, {
      maxRounds: 1,
      onDeadlock: 'fail',
      maxOffersPerRound: 1,
      allowCoalitions: false,
      turnTimeout: 0,
    }).execute({ input: 'deal' });

    expect(outcomes[0]).toMatchObject({ success: true });
    expect(outcomes[1]).toMatchObject({ success: false, error: expect.stringContaining('limit') });
    expect(outcomes[2]).toMatchObject({
      success: false,
      error: expect.stringContaining('not allowed'),
    });
  });

  it('passes turnTimeout to every negotiation turn', async () => {
    const coordinator = new MockCoordinator();
    coordinator.addAgent(createMockSwarmAgent('a'));
    coordinator.addAgent(createMockSwarmAgent('b'));

    await new NegotiationStrategy(coordinator, {
      maxRounds: 1,
      onDeadlock: 'fail',
      turnTimeout: 5000,
    }).execute({ input: 'deal' });

    expect(coordinator.getCalls().every((c) => c.options?.timeout === 5000)).toBe(true);
  });
});
