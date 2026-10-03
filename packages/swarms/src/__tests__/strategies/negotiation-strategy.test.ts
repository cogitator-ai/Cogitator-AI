import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NegotiationStrategy } from '../../strategies/negotiation-strategy';
import { MockCoordinator, getCallContext } from './__mocks__/mock-coordinator';
import { createMockSwarmAgent } from './__mocks__/mock-helpers';

describe('NegotiationStrategy', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  describe('initialization', () => {
    it('should throw when fewer than 2 negotiating agents', async () => {
      coordinator.addAgent(createMockSwarmAgent('solo'));
      coordinator.setAgentResponse('solo', 'I declare my interests');

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
      });

      await expect(strategy.execute({ input: 'negotiate' })).rejects.toThrow(
        'Negotiation strategy requires at least 2 agents'
      );
    });

    it('should not count supervisor as negotiating agent', async () => {
      coordinator.addAgent(createMockSwarmAgent('agent'));
      coordinator.addAgent(createMockSwarmAgent('supervisor', { role: 'supervisor' }));
      coordinator.setAgentResponse('agent', 'interests');
      coordinator.setAgentResponse('supervisor', 'decision');

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
      });

      await expect(strategy.execute({ input: 'negotiate' })).rejects.toThrow(
        'Negotiation strategy requires at least 2 agents'
      );
    });

    it('should not count moderator as negotiating agent', async () => {
      coordinator.addAgent(createMockSwarmAgent('agent'));
      coordinator.addAgent(createMockSwarmAgent('moderator', { role: 'moderator' }));
      coordinator.setAgentResponse('agent', 'interests');
      coordinator.setAgentResponse('moderator', 'moderate');

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
      });

      await expect(strategy.execute({ input: 'negotiate' })).rejects.toThrow(
        'Negotiation strategy requires at least 2 agents'
      );
    });
  });

  describe('phase progression', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('party-a'));
      coordinator.addAgent(createMockSwarmAgent('party-b'));
      coordinator.setAgentResponse('party-a', 'My position');
      coordinator.setAgentResponse('party-b', 'My position');
    });

    it('should run initialization phase first', async () => {
      const phaseHandler = vi.fn();
      coordinator.events.on('negotiation:phase-change', phaseHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(phaseHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ phase: 'initialization' }),
          agentName: 'system',
        })
      );
    });

    it('should run proposal phase after initialization', async () => {
      const phaseHandler = vi.fn();
      coordinator.events.on('negotiation:phase-change', phaseHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const phases = phaseHandler.mock.calls.map((c) => c[0].data?.phase);
      expect(phases).toContain('initialization');
      expect(phases).toContain('proposal');
    });

    it('should run counter phase after proposal', async () => {
      const phaseHandler = vi.fn();
      coordinator.events.on('negotiation:phase-change', phaseHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const phases = phaseHandler.mock.calls.map((c) => c[0].data?.phase);
      expect(phases).toContain('counter');
    });
  });

  describe('round execution', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('negotiator-1'));
      coordinator.addAgent(createMockSwarmAgent('negotiator-2'));
      coordinator.setAgentResponse('negotiator-1', 'position 1');
      coordinator.setAgentResponse('negotiator-2', 'position 2');
    });

    it('should run up to maxRounds', async () => {
      const roundHandler = vi.fn();
      coordinator.events.on('negotiation:round', roundHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 3,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(roundHandler).toHaveBeenCalledTimes(3);
    });

    it('should emit turn events for each agent', async () => {
      const turnHandler = vi.fn();
      coordinator.events.on('negotiation:turn', turnHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const agents = turnHandler.mock.calls.map((c) => c[0].data?.agent);
      expect(agents).toContain('negotiator-1');
      expect(agents).toContain('negotiator-2');
    });
  });

  describe('negotiation context', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('ctx-agent-1'));
      coordinator.addAgent(createMockSwarmAgent('ctx-agent-2'));
      coordinator.setAgentResponse('ctx-agent-1', 'position');
      coordinator.setAgentResponse('ctx-agent-2', 'position');
    });

    it('should pass negotiationContext to agents', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 2,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('ctx-agent-1')[0];
      expect(call?.context?.negotiationContext).toBeDefined();
      expect(getCallContext(call, 'negotiationContext')?.maxRounds).toBe(2);
    });

    it('should track current phase in context', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const initCall = coordinator
        .getCallsFor('ctx-agent-1')
        .find((c) => getCallContext(c, 'negotiationContext')?.phase === 'initialization');
      expect(initCall).toBeDefined();
    });
  });

  describe('deadlock handling', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('deadlock-a'));
      coordinator.addAgent(createMockSwarmAgent('deadlock-b'));
      coordinator.setAgentResponse('deadlock-a', 'my position unchanged');
      coordinator.setAgentResponse('deadlock-b', 'my position unchanged');
    });

    it('should return deadlock outcome on fail mode', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.negotiationResult?.outcome).toBe('deadlock');
    });

    it('should emit deadlock event', async () => {
      const deadlockHandler = vi.fn();
      coordinator.events.on('negotiation:deadlock', deadlockHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(deadlockHandler).toHaveBeenCalled();
    });

    it('should call supervisor on supervisor-decides mode', async () => {
      coordinator.addAgent(createMockSwarmAgent('supervisor', { role: 'supervisor' }));
      coordinator.setAgentResponse('supervisor', 'Final decision: split 50/50');

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'supervisor-decides',
      });

      await strategy.execute({ input: 'topic' });

      const supervisorCalls = coordinator.getCallsFor('supervisor');
      expect(supervisorCalls.length).toBeGreaterThan(0);
    });

    it('should emit escalation event on escalate mode', async () => {
      const escalationHandler = vi.fn();
      coordinator.events.on('negotiation:escalation', escalationHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'escalate',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(escalationHandler).toHaveBeenCalled();
      expect(result.negotiationResult?.outcome).toBe('escalated');
    });

    it('should return agreement via majority on majority-rules mode', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'majority-rules',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.negotiationResult?.outcome).toBe('agreement');
    });

    it('should emit arbitration event on arbitrate mode', async () => {
      const arbitrationHandler = vi.fn();
      coordinator.events.on('negotiation:arbitration', arbitrationHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'arbitrate',
      });

      await strategy.execute({ input: 'topic' });

      expect(arbitrationHandler).toHaveBeenCalled();
    });
  });

  describe('blackboard state', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('bb-agent-1'));
      coordinator.addAgent(createMockSwarmAgent('bb-agent-2'));
      coordinator.setAgentResponse('bb-agent-1', 'state');
      coordinator.setAgentResponse('bb-agent-2', 'state');
    });

    it('should initialize negotiation state on blackboard', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 2,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const state = coordinator.blackboard.read<Record<string, unknown>>('negotiation');
      expect(state).toBeDefined();
      expect(state?.maxRounds).toBe(2);
    });

    it('should track offers on blackboard', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const state = coordinator.blackboard.read<{ offers: unknown[] }>('negotiation');
      expect(state?.offers).toBeDefined();
    });

    it('should track turn history', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const state = coordinator.blackboard.read<{ turnHistory: unknown[] }>('negotiation');
      expect(state?.turnHistory).toBeDefined();
      expect(state?.turnHistory?.length).toBeGreaterThan(0);
    });
  });

  describe('events', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('event-a'));
      coordinator.addAgent(createMockSwarmAgent('event-b'));
      coordinator.setAgentResponse('event-a', 'position');
      coordinator.setAgentResponse('event-b', 'position');
    });

    it('should emit negotiation:start event', async () => {
      const startHandler = vi.fn();
      coordinator.events.on('negotiation:start', startHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(startHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agents: ['event-a', 'event-b'],
          }),
          agentName: 'system',
        })
      );
    });

    it('should emit negotiation:round for each round', async () => {
      const roundHandler = vi.fn();
      coordinator.events.on('negotiation:round', roundHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 2,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(roundHandler).toHaveBeenCalledTimes(2);
      expect(roundHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ round: 1, maxRounds: 2 }),
          agentName: 'system',
        })
      );
    });

    it('should emit negotiation:convergence-update', async () => {
      const convergenceHandler = vi.fn();
      coordinator.events.on('negotiation:convergence-update', convergenceHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(convergenceHandler).toHaveBeenCalled();
    });

    it('should emit negotiation:terminated on deadlock', async () => {
      const terminatedHandler = vi.fn();
      coordinator.events.on('negotiation:terminated', terminatedHandler);

      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      expect(terminatedHandler).toHaveBeenCalled();
    });
  });

  describe('result structure', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('result-a'));
      coordinator.addAgent(createMockSwarmAgent('result-b'));
      coordinator.setAgentResponse('result-a', 'final position');
      coordinator.setAgentResponse('result-b', 'final position');
    });

    it('should return negotiationResult', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.negotiationResult).toBeDefined();
      expect(result.negotiationResult?.negotiationId).toBeDefined();
    });

    it('should include outcome in result', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.negotiationResult?.outcome).toBeDefined();
      expect(['agreement', 'deadlock', 'escalated', 'arbitrated']).toContain(
        result.negotiationResult?.outcome
      );
    });

    it('should track convergence history', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 2,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.negotiationResult?.convergenceHistory).toBeDefined();
      expect(result.negotiationResult?.convergenceHistory?.length).toBeGreaterThan(0);
    });

    it('should record total rounds', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 3,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.negotiationResult?.rounds).toBe(3);
    });

    it('should track duration', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.negotiationResult?.duration).toBeDefined();
      expect(result.negotiationResult?.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include final positions', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.negotiationResult?.finalPositions).toBeDefined();
    });

    it('should include formatted output string', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.output).toContain('Negotiation');
      expect(result.output).toContain('Outcome');
      expect(result.output).toContain('Rounds');
    });

    it('should include agentResults for all phases', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      const resultKeys = Array.from(result.agentResults.keys());
      expect(resultKeys.some((k) => k.includes('init'))).toBe(true);
      expect(resultKeys.some((k) => k.includes('proposal'))).toBe(true);
    });
  });

  describe('prompts', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('prompt-agent-1'));
      coordinator.addAgent(createMockSwarmAgent('prompt-agent-2'));
      coordinator.setAgentResponse('prompt-agent-1', 'response');
      coordinator.setAgentResponse('prompt-agent-2', 'response');
    });

    it('should build initialization prompt with topic', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'salary negotiation' });

      const initCall = coordinator.getCallsFor('prompt-agent-1')[0];
      expect(initCall?.input).toContain('salary negotiation');
      expect(initCall?.input).toContain('initialization');
    });

    it('should build proposal prompt with round info', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 2,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const proposalCall = coordinator.getCalls().find((c) => c.input.includes('PROPOSAL phase'));
      expect(proposalCall).toBeDefined();
      expect(proposalCall?.input).toContain('Round');
    });

    it('should build proposal prompt with phase info', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      await strategy.execute({ input: 'topic' });

      const proposalCall = coordinator.getCalls().find((c) => c.input.includes('PROPOSAL phase'));
      expect(proposalCall).toBeDefined();
    });
  });

  describe('agent results keying', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('key-agent-1'));
      coordinator.addAgent(createMockSwarmAgent('key-agent-2'));
      coordinator.setAgentResponse('key-agent-1', 'out1');
      coordinator.setAgentResponse('key-agent-2', 'out2');
    });

    it('should key init results with _init suffix', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.agentResults.has('key-agent-1_init')).toBe(true);
      expect(result.agentResults.has('key-agent-2_init')).toBe(true);
    });

    it('should key proposal results with round number', async () => {
      const strategy = new NegotiationStrategy(coordinator, {
        maxRounds: 1,
        onDeadlock: 'fail',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.agentResults.has('key-agent-1_proposal_r1')).toBe(true);
    });
  });
});
