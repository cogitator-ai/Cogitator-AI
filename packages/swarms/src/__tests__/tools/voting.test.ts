import { describe, it, expect, beforeEach } from 'vitest';
import { createVotingTools } from '../../tools/voting.js';
import { InMemoryBlackboard } from '../../communication/blackboard.js';
import { SwarmEventEmitterImpl } from '../../communication/event-emitter.js';
import type { SwarmEvent } from '@cogitator-ai/types';

interface ConsensusState {
  topic: string;
  currentRound: number;
  maxRounds: number;
  votes: Array<{
    agentName: string;
    decision: string;
    reasoning?: string;
    weight: number;
    round: number;
    timestamp: number;
  }>;
  threshold: number;
  resolution: string;
}

function createConsensusState(overrides?: Partial<ConsensusState>): ConsensusState {
  return {
    topic: 'Best framework',
    currentRound: 1,
    maxRounds: 3,
    votes: [],
    threshold: 0.66,
    resolution: 'majority',
    ...overrides,
  };
}

describe('createVotingTools', () => {
  let blackboard: InMemoryBlackboard;
  let events: SwarmEventEmitterImpl;

  beforeEach(() => {
    blackboard = new InMemoryBlackboard({ enabled: true, sections: {}, trackHistory: false });
    events = new SwarmEventEmitterImpl();
  });

  describe('castVote', () => {
    it('should cast a vote successfully', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      const result = await castVote.execute({ decision: 'React', reasoning: 'Fast UI' });

      expect(result).toEqual({
        success: true,
        voteRecorded: true,
        round: 1,
        decision: 'React',
        weight: 1,
      });
    });

    it('should persist vote to blackboard', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await castVote.execute({ decision: 'Vue' });

      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes).toHaveLength(1);
      expect(state.votes[0].agentName).toBe('agent-alpha');
      expect(state.votes[0].decision).toBe('Vue');
      expect(state.votes[0].round).toBe(1);
      expect(state.votes[0].weight).toBe(1);
    });

    it('should use custom agent weight', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote } = createVotingTools(blackboard, events, 'lead-agent', 3);

      const result = await castVote.execute({ decision: 'Svelte' });

      expect(result.weight).toBe(3);
      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes[0].weight).toBe(3);
    });

    it('should reject duplicate vote in the same round', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await castVote.execute({ decision: 'React' });
      const dup = await castVote.execute({ decision: 'Vue' });

      expect(dup).toEqual({
        success: false,
        error: 'You already voted this round. Use change_vote to modify your vote.',
      });

      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes).toHaveLength(1);
      expect(state.votes[0].decision).toBe('React');
    });

    it('should allow same agent to vote in different rounds', async () => {
      const state = createConsensusState({ currentRound: 1 });
      blackboard.write('consensus', state, 'system');
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await castVote.execute({ decision: 'React' });

      const updated = blackboard.read<ConsensusState>('consensus');
      updated.currentRound = 2;
      blackboard.write('consensus', updated, 'system');

      const result = await castVote.execute({ decision: 'Vue' });
      expect(result.success).toBe(true);

      const final = blackboard.read<ConsensusState>('consensus');
      expect(final.votes).toHaveLength(2);
    });

    it('should allow different agents to vote in the same round', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 1);

      await toolsA.castVote.execute({ decision: 'React' });
      const result = await toolsB.castVote.execute({ decision: 'Vue' });

      expect(result.success).toBe(true);
      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes).toHaveLength(2);
    });

    it('should emit consensus:vote event', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const emitted: SwarmEvent[] = [];
      events.on('consensus:vote', (e) => emitted.push(e));

      await castVote.execute({ decision: 'React', confidence: 0.9 });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].agentName).toBe('agent-alpha');
      expect((emitted[0].data as Record<string, unknown>).decision).toBe('React');
      expect((emitted[0].data as Record<string, unknown>).confidence).toBe(0.9);
    });

    it('should return error when no consensus session exists', async () => {
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const result = await castVote.execute({ decision: 'React' });
      expect(result).toEqual({ success: false, error: 'No active consensus session' });
    });

    it('should store reasoning in the vote', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await castVote.execute({ decision: 'React', reasoning: 'Large ecosystem' });

      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes[0].reasoning).toBe('Large ecosystem');
    });
  });

  describe('changeVote', () => {
    it('should change an existing vote', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote, changeVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await castVote.execute({ decision: 'React' });
      const result = await changeVote.execute({ newDecision: 'Vue', reasoning: 'Changed mind' });

      expect(result).toEqual({
        success: true,
        previousDecision: 'React',
        newDecision: 'Vue',
        round: 1,
      });

      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes).toHaveLength(1);
      expect(state.votes[0].decision).toBe('Vue');
      expect(state.votes[0].reasoning).toBe('Changed mind');
    });

    it('should work even if no previous vote exists (acts as cast)', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { changeVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);

      const result = await changeVote.execute({ newDecision: 'Svelte' });

      expect(result.success).toBe(true);
      expect(result.previousDecision).toBeNull();
      expect(result.newDecision).toBe('Svelte');

      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes).toHaveLength(1);
    });

    it('should emit consensus:vote:changed event', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const { castVote, changeVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const emitted: SwarmEvent[] = [];
      events.on('consensus:vote:changed', (e) => emitted.push(e));

      await castVote.execute({ decision: 'React' });
      await changeVote.execute({ newDecision: 'Angular' });

      expect(emitted).toHaveLength(1);
      const data = emitted[0].data as Record<string, unknown>;
      expect(data.previousDecision).toBe('React');
      expect(data.newDecision).toBe('Angular');
    });

    it('should return error when no consensus session exists', async () => {
      const { changeVote } = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const result = await changeVote.execute({ newDecision: 'React' });
      expect(result).toEqual({ success: false, error: 'No active consensus session' });
    });

    it('should not affect other agents votes', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 1);

      await toolsA.castVote.execute({ decision: 'React' });
      await toolsB.castVote.execute({ decision: 'Vue' });
      await toolsA.changeVote.execute({ newDecision: 'Angular' });

      const state = blackboard.read<ConsensusState>('consensus');
      expect(state.votes).toHaveLength(2);
      const alphaVote = state.votes.find((v) => v.agentName === 'agent-alpha');
      const betaVote = state.votes.find((v) => v.agentName === 'agent-beta');
      expect(alphaVote?.decision).toBe('Angular');
      expect(betaVote?.decision).toBe('Vue');
    });
  });

  describe('getVotes', () => {
    it('should return all votes', async () => {
      blackboard.write(
        'consensus',
        createConsensusState({ threshold: 0.5, resolution: 'majority' }),
        'system'
      );
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 2);

      await toolsA.castVote.execute({ decision: 'React', reasoning: 'Popular' });
      await toolsB.castVote.execute({ decision: 'Vue', reasoning: 'Simple' });

      const result = await toolsA.getVotes.execute({});

      expect(result.success).toBe(true);
      expect(result.totalVotes).toBe(2);
      expect(result.votes).toHaveLength(2);
      expect(result.threshold).toBe(0.5);
      expect(result.resolution).toBe('majority');
    });

    it('should filter by round', async () => {
      const state = createConsensusState({ currentRound: 1 });
      blackboard.write('consensus', state, 'system');
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await tools.castVote.execute({ decision: 'React' });

      const s = blackboard.read<ConsensusState>('consensus');
      s.currentRound = 2;
      blackboard.write('consensus', s, 'system');
      await tools.castVote.execute({ decision: 'Vue' });

      const round1 = await tools.getVotes.execute({ round: 1 });
      expect(round1.totalVotes).toBe(1);
      expect(round1.votes![0].decision).toBe('React');

      const round2 = await tools.getVotes.execute({ round: 2 });
      expect(round2.totalVotes).toBe(1);
      expect(round2.votes![0].decision).toBe('Vue');

      const allRounds = await tools.getVotes.execute({});
      expect(allRounds.totalVotes).toBe(2);
    });

    it('should include reasoning when requested', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await tools.castVote.execute({ decision: 'React', reasoning: 'Ecosystem' });

      const withReasoning = await tools.getVotes.execute({ includeReasoning: true });
      expect(withReasoning.votes![0].reasoning).toBe('Ecosystem');

      const withoutReasoning = await tools.getVotes.execute({ includeReasoning: false });
      expect(withoutReasoning.votes![0]).not.toHaveProperty('reasoning');
    });

    it('should aggregate vote summary with counts and weighted counts', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 3);
      const toolsC = createVotingTools(blackboard, events, 'agent-gamma', 1);

      await toolsA.castVote.execute({ decision: 'React' });
      await toolsB.castVote.execute({ decision: 'React' });
      await toolsC.castVote.execute({ decision: 'Vue' });

      const result = await toolsA.getVotes.execute({});

      expect(result.summary).toHaveLength(2);

      const reactSummary = result.summary!.find(
        (s: { decision: string }) => s.decision === 'react'
      );
      const vueSummary = result.summary!.find((s: { decision: string }) => s.decision === 'vue');

      expect(reactSummary).toEqual({
        decision: 'react',
        count: 2,
        weightedCount: 4,
        voters: ['agent-alpha', 'agent-beta'],
      });
      expect(vueSummary).toEqual({
        decision: 'vue',
        count: 1,
        weightedCount: 1,
        voters: ['agent-gamma'],
      });
    });

    it('should return error when no consensus session exists', async () => {
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const result = await tools.getVotes.execute({});
      expect(result.success).toBe(false);
      expect(result.votes).toEqual([]);
    });

    it('should normalize decision keys (case-insensitive, trimmed)', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 1);

      await toolsA.castVote.execute({ decision: 'React' });
      await toolsB.castVote.execute({ decision: '  react  ' });

      const result = await toolsA.getVotes.execute({});
      expect(result.summary).toHaveLength(1);
      expect(result.summary![0].count).toBe(2);
    });
  });

  describe('getConsensusStatus', () => {
    it('should return inactive when no session exists', async () => {
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const result = await tools.getConsensusStatus.execute({});

      expect(result).toEqual({
        active: false,
        error: 'No active consensus session',
      });
    });

    it('should return full status for active session', async () => {
      blackboard.write(
        'consensus',
        createConsensusState({ topic: 'Best DB', maxRounds: 5, threshold: 0.75 }),
        'system'
      );
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);

      const status = await tools.getConsensusStatus.execute({});

      expect(status.active).toBe(true);
      expect(status.topic).toBe('Best DB');
      expect(status.currentRound).toBe(1);
      expect(status.maxRounds).toBe(5);
      expect(status.roundsRemaining).toBe(4);
      expect(status.threshold).toBe(0.75);
      expect(status.currentVotes).toBe(0);
      expect(status.hasVoted).toBe(false);
    });

    it('should detect when current agent has voted', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await tools.castVote.execute({ decision: 'Postgres' });
      const status = await tools.getConsensusStatus.execute({});

      expect(status.hasVoted).toBe(true);
    });

    it('should calculate majority consensus correctly', async () => {
      blackboard.write(
        'consensus',
        createConsensusState({ threshold: 0.6, resolution: 'majority' }),
        'system'
      );
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 1);
      const toolsC = createVotingTools(blackboard, events, 'agent-gamma', 1);

      await toolsA.castVote.execute({ decision: 'Postgres' });
      await toolsB.castVote.execute({ decision: 'Postgres' });
      await toolsC.castVote.execute({ decision: 'MySQL' });

      const status = await toolsA.getConsensusStatus.execute({});

      expect(status.leadingDecision).toBe('postgres');
      expect(status.leadingVotes).toBe(2);
      expect(status.consensusRatio).toBeCloseTo(0.67, 1);
      expect(status.wouldReachConsensus).toBe(true);
    });

    it('should report no consensus when below threshold', async () => {
      blackboard.write(
        'consensus',
        createConsensusState({ threshold: 0.8, resolution: 'majority' }),
        'system'
      );
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 1);
      const toolsC = createVotingTools(blackboard, events, 'agent-gamma', 1);

      await toolsA.castVote.execute({ decision: 'Postgres' });
      await toolsB.castVote.execute({ decision: 'Postgres' });
      await toolsC.castVote.execute({ decision: 'MySQL' });

      const status = await toolsA.getConsensusStatus.execute({});

      expect(status.wouldReachConsensus).toBe(false);
    });

    it('should calculate weighted consensus correctly', async () => {
      blackboard.write(
        'consensus',
        createConsensusState({ threshold: 0.6, resolution: 'weighted' }),
        'system'
      );
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 5);

      await toolsA.castVote.execute({ decision: 'MySQL' });
      await toolsB.castVote.execute({ decision: 'Postgres' });

      const status = await toolsA.getConsensusStatus.execute({});

      expect(status.resolution).toBe('weighted');
      expect(status.leadingDecision).toBe('postgres');
      expect(status.leadingVotes).toBe(5);
      expect(status.consensusRatio).toBeCloseTo(0.83, 1);
      expect(status.wouldReachConsensus).toBe(true);
    });

    it('should use weighted denominator instead of vote count for weighted mode', async () => {
      blackboard.write(
        'consensus',
        createConsensusState({ threshold: 0.5, resolution: 'weighted' }),
        'system'
      );
      const toolsA = createVotingTools(blackboard, events, 'agent-alpha', 1);
      const toolsB = createVotingTools(blackboard, events, 'agent-beta', 1);
      const toolsC = createVotingTools(blackboard, events, 'agent-gamma', 10);

      await toolsA.castVote.execute({ decision: 'X' });
      await toolsB.castVote.execute({ decision: 'X' });
      await toolsC.castVote.execute({ decision: 'Y' });

      const status = await toolsA.getConsensusStatus.execute({});

      expect(status.leadingDecision).toBe('y');
      expect(status.leadingVotes).toBe(10);
      expect(status.consensusRatio).toBeCloseTo(10 / 12, 1);
    });

    it('should only count votes from the current round', async () => {
      const state = createConsensusState({ currentRound: 1 });
      blackboard.write('consensus', state, 'system');
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);

      await tools.castVote.execute({ decision: 'X' });

      const s = blackboard.read<ConsensusState>('consensus');
      s.currentRound = 2;
      blackboard.write('consensus', s, 'system');

      const status = await tools.getConsensusStatus.execute({});

      expect(status.currentVotes).toBe(0);
      expect(status.hasVoted).toBe(false);
      expect(status.leadingDecision).toBe('');
    });

    it('should handle zero votes gracefully', async () => {
      blackboard.write('consensus', createConsensusState(), 'system');
      const tools = createVotingTools(blackboard, events, 'agent-alpha', 1);

      const status = await tools.getConsensusStatus.execute({});

      expect(status.consensusRatio).toBe(0);
      expect(status.wouldReachConsensus).toBe(false);
      expect(status.leadingDecision).toBe('');
    });
  });
});
