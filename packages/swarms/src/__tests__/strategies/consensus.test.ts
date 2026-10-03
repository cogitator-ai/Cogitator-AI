import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsensusStrategy } from '../../strategies/consensus';
import { MockCoordinator } from './__mocks__/mock-coordinator';
import { createMockSwarmAgent } from './__mocks__/mock-helpers';

describe('ConsensusStrategy', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  describe('initialization', () => {
    it('should throw when fewer than 2 agents', async () => {
      coordinator.addAgent(createMockSwarmAgent('solo'));
      coordinator.setAgentResponse('solo', 'VOTE: yes');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      await expect(strategy.execute({ input: 'topic' })).rejects.toThrow(
        'Consensus strategy requires at least 2 agents'
      );
    });

    it('should work with exactly 2 agents', async () => {
      coordinator.addAgent(createMockSwarmAgent('agent-a'));
      coordinator.addAgent(createMockSwarmAgent('agent-b'));
      coordinator.setAgentResponse('agent-a', 'VOTE: yes');
      coordinator.setAgentResponse('agent-b', 'VOTE: yes');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
    });
  });

  describe('vote extraction', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('voter-1'));
      coordinator.addAgent(createMockSwarmAgent('voter-2'));
    });

    it('should extract VOTE: format', async () => {
      coordinator.setAgentResponse('voter-1', 'VOTE: approve\nBecause it is good');
      coordinator.setAgentResponse('voter-2', 'VOTE: approve\nI agree');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.votes?.get('voter-1_round1')).toMatchObject({
        decision: 'approve',
      });
    });

    it('should extract lowercase vote: format', async () => {
      coordinator.setAgentResponse('voter-1', 'vote: yes\nReasoning here');
      coordinator.setAgentResponse('voter-2', 'vote: yes');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.votes?.get('voter-1_round1')).toMatchObject({
        decision: 'yes',
      });
    });

    it('should extract alternative decision: format', async () => {
      coordinator.setAgentResponse('voter-1', 'After thinking, decision: option A');
      coordinator.setAgentResponse('voter-2', 'My choice: option A');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.votes?.get('voter-1_round1')).toMatchObject({
        decision: 'option A',
      });
    });

    it('should include reasoning in vote', async () => {
      coordinator.setAgentResponse('voter-1', 'VOTE: yes\nThis is my reasoning for voting yes');
      coordinator.setAgentResponse('voter-2', 'VOTE: yes');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.votes?.get('voter-1_round1')).toMatchObject({
        reasoning: expect.stringContaining('reasoning for voting yes'),
      });
    });
  });

  describe('majority resolution', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('a'));
      coordinator.addAgent(createMockSwarmAgent('b'));
      coordinator.addAgent(createMockSwarmAgent('c'));
    });

    it('should reach consensus when majority achieved', async () => {
      coordinator.setAgentResponse('a', 'VOTE: yes');
      coordinator.setAgentResponse('b', 'VOTE: yes');
      coordinator.setAgentResponse('c', 'VOTE: no');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
      expect(result.output).toContain('yes');
    });

    it('should not reach consensus when below threshold', async () => {
      coordinator.setAgentResponse('a', 'VOTE: yes');
      coordinator.setAgentResponse('b', 'VOTE: no');
      coordinator.setAgentResponse('c', 'VOTE: maybe');

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
        onNoConsensus: 'escalate',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('NO CONSENSUS');
    });

    it('should respect threshold value', async () => {
      coordinator.setAgentResponse('a', 'VOTE: yes');
      coordinator.setAgentResponse('b', 'VOTE: yes');
      coordinator.setAgentResponse('c', 'VOTE: no');

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.75,
        onNoConsensus: 'escalate',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('NO CONSENSUS');
    });
  });

  describe('unanimous resolution', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('voter-1'));
      coordinator.addAgent(createMockSwarmAgent('voter-2'));
      coordinator.addAgent(createMockSwarmAgent('voter-3'));
    });

    it('should reach consensus when all vote same', async () => {
      coordinator.setAgentResponse('voter-1', 'VOTE: accept');
      coordinator.setAgentResponse('voter-2', 'VOTE: accept');
      coordinator.setAgentResponse('voter-3', 'VOTE: accept');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
    });

    it('should not reach consensus with one dissent', async () => {
      coordinator.setAgentResponse('voter-1', 'VOTE: accept');
      coordinator.setAgentResponse('voter-2', 'VOTE: accept');
      coordinator.setAgentResponse('voter-3', 'VOTE: reject');

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'escalate',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('NO CONSENSUS');
    });

    it('should normalize vote decisions for comparison', async () => {
      coordinator.setAgentResponse('voter-1', 'VOTE: Yes');
      coordinator.setAgentResponse('voter-2', 'VOTE: YES');
      coordinator.setAgentResponse('voter-3', 'VOTE: yes');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
    });
  });

  describe('weighted resolution', () => {
    it('should use agent weights from config', async () => {
      coordinator.addAgent(createMockSwarmAgent('expert'));
      coordinator.addAgent(createMockSwarmAgent('junior'));
      coordinator.setAgentResponse('expert', 'VOTE: plan-a');
      coordinator.setAgentResponse('junior', 'VOTE: plan-b');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'weighted',
        threshold: 0.6,
        weights: {
          expert: 3,
          junior: 1,
        },
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
      expect(result.output).toContain('plan-a');
    });

    it('should use agent metadata weight', async () => {
      coordinator.addAgent(createMockSwarmAgent('weighted-agent', { weight: 5 }));
      coordinator.addAgent(createMockSwarmAgent('normal-agent'));
      coordinator.setAgentResponse('weighted-agent', 'VOTE: option-x');
      coordinator.setAgentResponse('normal-agent', 'VOTE: option-y');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'weighted',
        threshold: 0.7,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
      expect(result.output).toContain('option-x');
    });

    it('should default weight to 1', async () => {
      coordinator.addAgent(createMockSwarmAgent('agent-1'));
      coordinator.addAgent(createMockSwarmAgent('agent-2'));
      coordinator.setAgentResponse('agent-1', 'VOTE: same');
      coordinator.setAgentResponse('agent-2', 'VOTE: same');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'weighted',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.votes?.get('agent-1_round1')).toMatchObject({ weight: 1 });
    });
  });

  describe('multiple rounds', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('persistent'));
      coordinator.addAgent(createMockSwarmAgent('changeable'));
    });

    it('should run multiple rounds until consensus', async () => {
      let changeableRound = 0;
      coordinator.setAgentResponse('persistent', 'VOTE: yes');
      coordinator.setAgentResponse('changeable', () => {
        changeableRound++;
        return changeableRound === 1 ? 'VOTE: no' : 'VOTE: yes';
      });

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 3,
        resolution: 'unanimous',
        threshold: 1.0,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');
      expect(result.output).toContain('Rounds: 2');
    });

    it('should pass previous discussion to later rounds', async () => {
      coordinator.setAgentResponse('persistent', 'VOTE: yes\nMy argument for yes');
      coordinator.setAgentResponse('changeable', 'VOTE: no');

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 2,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'escalate',
      });

      await strategy.execute({ input: 'topic' });

      const round2Calls = coordinator.getCalls().filter((c) => c.input.includes('Previous'));
      expect(round2Calls.length).toBeGreaterThan(0);
    });

    it('should record votes for each round', async () => {
      coordinator.setAgentResponse('persistent', 'VOTE: yes');
      coordinator.setAgentResponse('changeable', 'VOTE: no');

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 2,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'escalate',
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.votes?.has('persistent_round1')).toBe(true);
      expect(result.votes?.has('persistent_round2')).toBe(true);
    });
  });

  describe('onNoConsensus handling', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('stubborn-a'));
      coordinator.addAgent(createMockSwarmAgent('stubborn-b'));
      coordinator.setAgentResponse('stubborn-a', 'VOTE: option-1');
      coordinator.setAgentResponse('stubborn-b', 'VOTE: option-2');
    });

    it('should throw on fail mode', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'fail',
      });

      await expect(strategy.execute({ input: 'topic' })).rejects.toThrow(
        'Consensus not reached after 1 rounds'
      );
    });

    it('should return escalation message on escalate mode', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'escalate',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('ESCALATION REQUIRED');
      expect(result.output).toContain('escalate to human');
    });

    it('should call supervisor on supervisor-decides mode', async () => {
      const supervisor = createMockSwarmAgent('supervisor', { role: 'supervisor' });
      coordinator.addAgent(supervisor);
      coordinator.setAgentResponse('supervisor', 'FINAL DECISION: option-1\nI decided based on...');

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'supervisor-decides',
      });

      const result = await strategy.execute({ input: 'topic' });

      const supervisorCall = coordinator.getLastCallFor('supervisor');
      expect(supervisorCall).toBeDefined();
      expect(supervisorCall?.input).toContain('not reached consensus');
      expect(result.output).toContain('FINAL DECISION: option-1');
    });

    it('should fallback to no-consensus output if no supervisor', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'supervisor-decides',
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('NO CONSENSUS');
    });
  });

  describe('supervisor exclusion', () => {
    it('should not include supervisor in voting', async () => {
      coordinator.addAgent(createMockSwarmAgent('worker-1'));
      coordinator.addAgent(createMockSwarmAgent('worker-2'));
      coordinator.addAgent(createMockSwarmAgent('supervisor', { role: 'supervisor' }));

      coordinator.setAgentResponse('worker-1', 'VOTE: yes');
      coordinator.setAgentResponse('worker-2', 'VOTE: yes');
      coordinator.setAgentResponse('supervisor', 'VOTE: no');

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
      });

      const result = await strategy.execute({ input: 'topic' });
      expect(result.output).toContain('CONSENSUS REACHED');

      const supervisorCalls = coordinator.getCallsFor('supervisor');
      expect(supervisorCalls).toHaveLength(0);
    });
  });

  describe('blackboard state', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('v1'));
      coordinator.addAgent(createMockSwarmAgent('v2'));
      coordinator.setAgentResponse('v1', 'VOTE: yes');
      coordinator.setAgentResponse('v2', 'VOTE: yes');
    });

    it('should initialize consensus state on blackboard', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 3,
        resolution: 'majority',
        threshold: 0.6,
      });

      await strategy.execute({ input: 'test topic' });

      const state = coordinator.blackboard.read<Record<string, unknown>>('consensus');
      expect(state).toBeDefined();
      expect(state?.topic).toBe('test topic');
      expect(state?.maxRounds).toBe(3);
      expect(state?.resolution).toBe('majority');
    });

    it('should update blackboard with votes', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      await strategy.execute({ input: 'topic' });

      const state = coordinator.blackboard.read<{ votes: unknown[] }>('consensus');
      expect(state?.votes).toHaveLength(2);
    });
  });

  describe('events', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('e1'));
      coordinator.addAgent(createMockSwarmAgent('e2'));
      coordinator.setAgentResponse('e1', 'VOTE: agree');
      coordinator.setAgentResponse('e2', 'VOTE: agree');
    });

    it('should emit consensus:round event', async () => {
      const roundHandler = vi.fn();
      coordinator.events.on('consensus:round', roundHandler);

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 2,
        resolution: 'majority',
        threshold: 0.5,
      });

      await strategy.execute({ input: 'topic' });

      expect(roundHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ round: 1, total: 2 }),
        })
      );
    });

    it('should emit consensus:turn for each agent', async () => {
      const turnHandler = vi.fn();
      coordinator.events.on('consensus:turn', turnHandler);

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      await strategy.execute({ input: 'topic' });

      expect(turnHandler).toHaveBeenCalledTimes(2);
      expect(turnHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ round: 1, agent: 'e1' }),
          agentName: 'e1',
        })
      );
    });

    it('should emit consensus:reached when achieved', async () => {
      const reachedHandler = vi.fn();
      coordinator.events.on('consensus:reached', reachedHandler);

      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      await strategy.execute({ input: 'topic' });

      expect(reachedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            round: 1,
            decision: 'agree',
          }),
        })
      );
    });

    it('should not emit consensus:reached when not achieved', async () => {
      coordinator.setAgentResponse('e1', 'VOTE: yes');
      coordinator.setAgentResponse('e2', 'VOTE: no');

      const reachedHandler = vi.fn();
      coordinator.events.on('consensus:reached', reachedHandler);

      const strategy = new ConsensusStrategy(coordinator, {
        maxRounds: 1,
        resolution: 'unanimous',
        threshold: 1.0,
        onNoConsensus: 'escalate',
      });

      await strategy.execute({ input: 'topic' });

      expect(reachedHandler).not.toHaveBeenCalled();
    });
  });

  describe('consensus context', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('ctx-agent'));
      coordinator.addAgent(createMockSwarmAgent('ctx-agent-2'));
      coordinator.setAgentResponse('ctx-agent', 'VOTE: yes');
      coordinator.setAgentResponse('ctx-agent-2', 'VOTE: yes');
    });

    it('should pass consensusContext to agents', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 3,
        resolution: 'weighted',
        threshold: 0.7,
      });

      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('ctx-agent')[0];
      expect(call?.context?.consensusContext).toMatchObject({
        round: 1,
        totalRounds: 3,
        resolution: 'weighted',
        threshold: 0.7,
      });
    });

    it('should include consensusInstructions', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 2,
        resolution: 'majority',
        threshold: 0.6,
      });

      await strategy.execute({ input: 'topic' });

      const call = coordinator.getCallsFor('ctx-agent')[0];
      expect(call?.context?.consensusInstructions).toContain('Round 1 of 2');
      expect(call?.context?.consensusInstructions).toContain('60%');
    });
  });

  describe('result structure', () => {
    beforeEach(() => {
      coordinator.addAgent(createMockSwarmAgent('r1'));
      coordinator.addAgent(createMockSwarmAgent('r2'));
      coordinator.setAgentResponse('r1', 'VOTE: final-decision');
      coordinator.setAgentResponse('r2', 'VOTE: final-decision');
    });

    it('should return votes map', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.votes).toBeInstanceOf(Map);
      expect(result.votes?.size).toBeGreaterThan(0);
    });

    it('should include agentResults for each round', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.agentResults.has('r1_round1')).toBe(true);
      expect(result.agentResults.has('r2_round1')).toBe(true);
    });

    it('should include vote history in output', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.output).toContain('Vote History');
      expect(result.output).toContain('r1');
      expect(result.output).toContain('r2');
    });

    it('should include final vote tally', async () => {
      const strategy = new ConsensusStrategy(coordinator, {
        onNoConsensus: 'fail',
        maxRounds: 1,
        resolution: 'majority',
        threshold: 0.5,
      });

      const result = await strategy.execute({ input: 'topic' });

      expect(result.output).toContain('Final Vote Tally');
      expect(result.output).toContain('final-decision');
    });
  });
});
