import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DebateStrategy } from '../../strategies/debate';
import { MockCoordinator, getCallContext } from './__mocks__/mock-coordinator';
import { createMockSwarmAgent } from './__mocks__/mock-helpers';

describe('DebateStrategy', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  describe('initialization', () => {
    it('should throw when fewer than 2 debating agents', async () => {
      coordinator.addAgent(createMockSwarmAgent('solo-debater'));
      coordinator.setAgentResponse('solo-debater', 'My argument');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });

      await expect(strategy.execute({ input: 'topic' })).rejects.toThrow(
        'Debate strategy requires at least 2 debating agents'
      );
    });

    it('should not count moderator as debater', async () => {
      coordinator.addAgent(createMockSwarmAgent('debater', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('debater', 'argument');
      coordinator.setAgentResponse('moderator', 'synthesis');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });

      await expect(strategy.execute({ input: 'topic' })).rejects.toThrow(
        'Debate strategy requires at least 2 debating agents'
      );
    });

    it('should use default format of structured', async () => {
      coordinator.addAgent(createMockSwarmAgent('d1'));
      coordinator.addAgent(createMockSwarmAgent('d2'));
      coordinator.setAgentResponse('d1', 'arg1');
      coordinator.setAgentResponse('d2', 'arg2');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('d1')[0];
      expect(getCallContext(call, 'debateContext')?.format).toBe('structured');
    });
  });

  describe('role selection', () => {
    it('should include advocates and critics as debaters', async () => {
      coordinator.addAgent(createMockSwarmAgent('pro', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('con', { role: 'critic' }));
      coordinator.setAgentResponse('pro', 'for argument');
      coordinator.setAgentResponse('con', 'against argument');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      expect(coordinator.getCallsFor('pro').length).toBeGreaterThan(0);
      expect(coordinator.getCallsFor('con').length).toBeGreaterThan(0);
    });

    it('should fall back to all non-moderator agents when no advocates/critics', async () => {
      coordinator.addAgent(createMockSwarmAgent('agent-a'));
      coordinator.addAgent(createMockSwarmAgent('agent-b'));
      coordinator.addAgent(createMockSwarmAgent('mod', { role: 'moderator' }));
      coordinator.setAgentResponse('agent-a', 'argument a');
      coordinator.setAgentResponse('agent-b', 'argument b');
      coordinator.setAgentResponse('mod', 'synthesis');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      expect(coordinator.getCallsFor('agent-a').length).toBeGreaterThan(0);
      expect(coordinator.getCallsFor('agent-b').length).toBeGreaterThan(0);
    });
  });

  describe('round execution', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('debater-1'));
      coordinator.addAgent(createMockSwarmAgent('debater-2'));
      coordinator.setAgentResponse('debater-1', 'argument from debater 1');
      coordinator.setAgentResponse('debater-2', 'argument from debater 2');
    });

    it('should run specified number of rounds', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 3 });
      await strategy.execute({ input: 'topic' });

      expect(coordinator.getCallsFor('debater-1')).toHaveLength(3);
      expect(coordinator.getCallsFor('debater-2')).toHaveLength(3);
    });

    it('should give all debaters a turn each round', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      const result = await strategy.execute({ input: 'topic' });

      expect(result.agentResults.has('debater-1_round1')).toBe(true);
      expect(result.agentResults.has('debater-1_round2')).toBe(true);
      expect(result.agentResults.has('debater-2_round1')).toBe(true);
      expect(result.agentResults.has('debater-2_round2')).toBe(true);
    });

    it('should pass original input in round 1', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'Should AI be regulated?' });

      const call = coordinator.getCallsFor('debater-1')[0];
      expect(call?.input).toBe('Should AI be regulated?');
    });

    it('should include previous arguments in later rounds', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      await strategy.execute({ input: 'topic' });

      const round2Call = coordinator.getCallsFor('debater-1')[1];
      expect(round2Call?.input).toContain('Continue the debate');
      expect(round2Call?.input).toContain('Previous arguments');
    });
  });

  describe('debate context', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('ctx-debater', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('ctx-debater-2', { role: 'critic' }));
      coordinator.setAgentResponse('ctx-debater', 'argument');
      coordinator.setAgentResponse('ctx-debater-2', 'counter');
    });

    it('should pass debateContext to agents', async () => {
      const strategy = new DebateStrategy(coordinator, {
        rounds: 3,
        format: 'freeform',
      });

      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('ctx-debater')[0];
      expect(call?.context?.debateContext).toMatchObject({
        round: 1,
        totalRounds: 3,
        role: 'advocate',
        format: 'freeform',
      });
    });

    it('should include debateInstructions', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      await strategy.execute({ input: 'topic' });

      const advocateCall = coordinator.getCallsFor('ctx-debater')[0];
      expect(advocateCall?.context?.debateInstructions).toContain('IN FAVOR');

      const criticCall = coordinator.getCallsFor('ctx-debater-2')[0];
      expect(criticCall?.context?.debateInstructions).toContain('AGAINST');
    });

    it('should include round info in instructions', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 3 });
      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('ctx-debater')[0];
      expect(call?.context?.debateInstructions).toContain('round 1 of 3');
    });
  });

  describe('moderator synthesis', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('advocate', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('critic', { role: 'critic' }));
      coordinator.setAgentResponse('advocate', 'pro argument');
      coordinator.setAgentResponse('critic', 'con argument');
    });

    it('should call moderator for synthesis when present', async () => {
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('moderator', 'Balanced synthesis of the debate');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'debate topic' });

      const modCall = coordinator.getLastCallFor('moderator');
      expect(modCall).toBeDefined();
      expect(modCall?.input).toContain('Synthesize');
      expect(result.output).toBe('Balanced synthesis of the debate');
    });

    it('should pass debate transcript to moderator', async () => {
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('moderator', 'synthesis');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      const modCall = coordinator.getLastCallFor('moderator');
      expect(modCall?.input).toContain('pro argument');
      expect(modCall?.input).toContain('con argument');
    });

    it('should pass moderatorContext', async () => {
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('moderator', 'synthesis');

      const strategy = new DebateStrategy(coordinator, {
        rounds: 2,
        format: 'structured',
      });

      await strategy.execute({ input: 'topic' });

      const modCall = coordinator.getLastCallFor('moderator');
      expect(modCall?.context?.moderatorContext).toMatchObject({
        debateRounds: 2,
        participantCount: 2,
        format: 'structured',
      });
    });

    it('should include moderator result in agentResults', async () => {
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('moderator', 'final synthesis');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'topic' });

      expect(result.agentResults.has('moderator')).toBe(true);
      expect(result.agentResults.get('moderator')?.output).toBe('final synthesis');
    });
  });

  describe('no moderator fallback', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('d1'));
      coordinator.addAgent(createMockSwarmAgent('d2'));
      coordinator.setAgentResponse('d1', 'first debater argument');
      coordinator.setAgentResponse('d2', 'second debater argument');
    });

    it('should synthesize debate without moderator', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'the topic' });

      expect(result.output).toContain('Debate Summary');
      expect(result.output).toContain('the topic');
    });

    it('should include all agent arguments in synthesis', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'topic' });

      expect(result.output).toContain('d1');
      expect(result.output).toContain('d2');
    });
  });

  describe('blackboard state', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('bb-d1'));
      coordinator.addAgent(createMockSwarmAgent('bb-d2'));
      coordinator.setAgentResponse('bb-d1', 'arg1');
      coordinator.setAgentResponse('bb-d2', 'arg2');
    });

    it('should initialize debate state on blackboard', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      await strategy.execute({ input: 'debate topic' });

      const state = coordinator.blackboard.read<Record<string, unknown>>('debate');
      expect(state).toBeDefined();
      expect(state?.topic).toBe('debate topic');
      expect(state?.rounds).toBe(2);
    });

    it('should update blackboard with arguments', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      const state = coordinator.blackboard.read<{ arguments: unknown[] }>('debate');
      expect(state?.arguments).toHaveLength(2);
    });

    it('should track current round', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      await strategy.execute({ input: 'topic' });

      const state = coordinator.blackboard.read<{ currentRound: number }>('debate');
      expect(state?.currentRound).toBe(2);
    });
  });

  describe('events', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('event-d1', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('event-d2', { role: 'critic' }));
      coordinator.setAgentResponse('event-d1', 'arg');
      coordinator.setAgentResponse('event-d2', 'counter');
    });

    it('should emit debate:round event', async () => {
      const roundHandler = vi.fn();
      coordinator.events.on('debate:round', roundHandler);

      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      await strategy.execute({ input: 'topic' });

      expect(roundHandler).toHaveBeenCalledTimes(2);
      expect(roundHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ round: 1, total: 2 }),
        })
      );
      expect(roundHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ round: 2, total: 2 }),
        })
      );
    });

    it('should emit debate:turn for each debater turn', async () => {
      const turnHandler = vi.fn();
      coordinator.events.on('debate:turn', turnHandler);

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      expect(turnHandler).toHaveBeenCalledTimes(2);
      expect(turnHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            round: 1,
            agent: 'event-d1',
            role: 'advocate',
          }),
          agentName: 'event-d1',
        })
      );
      expect(turnHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            round: 1,
            agent: 'event-d2',
            role: 'critic',
          }),
          agentName: 'event-d2',
        })
      );
    });
  });

  describe('debate transcript', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('trans-d1'));
      coordinator.addAgent(createMockSwarmAgent('trans-d2'));
      coordinator.setAgentResponse('trans-d1', 'First argument');
      coordinator.setAgentResponse('trans-d2', 'Second argument');
    });

    it('should return debateTranscript in result', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'topic' });

      expect(result.debateTranscript).toBeDefined();
      expect(result.debateTranscript).toHaveLength(2);
    });

    it('should include message metadata', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      const result = await strategy.execute({ input: 'topic' });

      const transcript = result.debateTranscript as Array<{ metadata?: Record<string, unknown> }>;
      expect(transcript?.[0].metadata?.round).toBe(1);
    });

    it('should include argument content', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'topic' });

      const transcript = result.debateTranscript as Array<{ content: string }>;
      const contents = transcript?.map((t) => t.content);
      expect(contents).toContain('First argument');
      expect(contents).toContain('Second argument');
    });
  });

  describe('result structure', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('res-d1'));
      coordinator.addAgent(createMockSwarmAgent('res-d2'));
      coordinator.setAgentResponse('res-d1', 'arg1');
      coordinator.setAgentResponse('res-d2', 'arg2');
    });

    it('should include agentResults for all rounds', async () => {
      const strategy = new DebateStrategy(coordinator, { rounds: 2 });
      const result = await strategy.execute({ input: 'topic' });

      expect(result.agentResults.has('res-d1_round1')).toBe(true);
      expect(result.agentResults.has('res-d1_round2')).toBe(true);
      expect(result.agentResults.has('res-d2_round1')).toBe(true);
      expect(result.agentResults.has('res-d2_round2')).toBe(true);
    });

    it('should pass through structured output from moderator', async () => {
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('moderator', {
        output: 'synthesis',
        structured: { conclusion: 'balanced' },
        runId: 'run1',
        agentId: 'agent1',
        threadId: 'thread1',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, duration: 0 },
        toolCalls: [],
        messages: [],
        trace: { traceId: 'trace1', spans: [] },
      });

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      const result = await strategy.execute({ input: 'topic' });

      expect(result.structured).toEqual({ conclusion: 'balanced' });
    });
  });

  describe('debate instructions by role', () => {
    it('should give advocate IN FAVOR instructions', async () => {
      coordinator.addAgent(createMockSwarmAgent('adv', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('crit', { role: 'critic' }));
      coordinator.setAgentResponse('adv', 'pro');
      coordinator.setAgentResponse('crit', 'con');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('adv')[0];
      expect(call?.context?.debateInstructions).toContain('IN FAVOR');
    });

    it('should give critic AGAINST instructions', async () => {
      coordinator.addAgent(createMockSwarmAgent('adv', { role: 'advocate' }));
      coordinator.addAgent(createMockSwarmAgent('crit', { role: 'critic' }));
      coordinator.setAgentResponse('adv', 'pro');
      coordinator.setAgentResponse('crit', 'con');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('crit')[0];
      expect(call?.context?.debateInstructions).toContain('AGAINST');
    });

    it('should give neutral debater perspective instructions', async () => {
      coordinator.addAgent(createMockSwarmAgent('neutral1'));
      coordinator.addAgent(createMockSwarmAgent('neutral2'));
      coordinator.setAgentResponse('neutral1', 'view1');
      coordinator.setAgentResponse('neutral2', 'view2');

      const strategy = new DebateStrategy(coordinator, { rounds: 1 });
      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('neutral1')[0];
      expect(call?.context?.debateInstructions).toContain('Present your perspective');
    });
  });
});
