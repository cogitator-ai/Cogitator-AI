/**
 * Swarm voting tools for consensus decision-making
 */

import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Blackboard, SwarmEventEmitter } from '@cogitator-ai/types';

interface Vote {
  agentName: string;
  decision: string;
  reasoning?: string;
  weight: number;
  round: number;
  timestamp: number;
}

/**
 * Create voting tools for consensus strategies
 */
function safeReadConsensus<T>(blackboard: Blackboard): T | null {
  try {
    return blackboard.read<T>('consensus');
  } catch {
    return null;
  }
}

export function createVotingTools(
  blackboard: Blackboard,
  events: SwarmEventEmitter,
  currentAgent: string,
  agentWeight = 1
) {
  const castVote = tool({
    name: 'cast_vote',
    description: 'Cast a vote in the current consensus round',
    parameters: z.object({
      decision: z.string().describe('Your decision/vote'),
      reasoning: z.string().optional().describe('Optional reasoning for your vote'),
      confidence: z
        .number()
        .optional()
        .describe('Confidence level 0-1 (optional, affects display only)'),
    }),
    execute: async ({ decision, reasoning, confidence }) => {
      const consensusState = safeReadConsensus<{
        currentRound: number;
        votes: Vote[];
      }>(blackboard);

      if (!consensusState) {
        return {
          success: false,
          error: 'No active consensus session',
        };
      }

      const existingIndex = consensusState.votes.findIndex(
        (v) => v.agentName === currentAgent && v.round === consensusState.currentRound
      );
      if (existingIndex >= 0) {
        return {
          success: false,
          error: 'You already voted this round. Use change_vote to modify your vote.',
        };
      }

      const vote: Vote = {
        agentName: currentAgent,
        decision,
        reasoning,
        weight: agentWeight,
        round: consensusState.currentRound,
        timestamp: Date.now(),
      };

      consensusState.votes.push(vote);
      blackboard.write('consensus', consensusState, currentAgent);

      events.emit(
        'consensus:vote',
        {
          agent: currentAgent,
          decision,
          round: consensusState.currentRound,
          confidence,
        },
        currentAgent
      );

      return {
        success: true,
        voteRecorded: true,
        round: consensusState.currentRound,
        decision,
        weight: agentWeight,
      };
    },
  });

  const getVotes = tool({
    name: 'get_votes',
    description: 'Get all votes cast in the current consensus session',
    parameters: z.object({
      round: z
        .number()
        .optional()
        .describe('Specific round to get votes for (all rounds if omitted)'),
      includeReasoning: z.boolean().optional().describe('Include vote reasoning'),
    }),
    execute: async ({ round, includeReasoning = false }) => {
      const consensusState = safeReadConsensus<{
        currentRound: number;
        votes: Vote[];
        threshold: number;
        resolution: string;
      }>(blackboard);

      if (!consensusState) {
        return {
          success: false,
          error: 'No active consensus session',
          votes: [],
        };
      }

      let votes = consensusState.votes;

      if (round !== undefined) {
        votes = votes.filter((v) => v.round === round);
      }

      const voteCounts = new Map<string, { count: number; weighted: number; voters: string[] }>();
      for (const vote of votes) {
        const key = vote.decision.toLowerCase().trim();
        const existing = voteCounts.get(key) ?? { count: 0, weighted: 0, voters: [] };
        existing.count++;
        existing.weighted += vote.weight;
        existing.voters.push(vote.agentName);
        voteCounts.set(key, existing);
      }

      return {
        success: true,
        currentRound: consensusState.currentRound,
        totalVotes: votes.length,
        threshold: consensusState.threshold,
        resolution: consensusState.resolution,
        votes: votes.map((v) => ({
          agent: v.agentName,
          decision: v.decision,
          round: v.round,
          weight: v.weight,
          ...(includeReasoning ? { reasoning: v.reasoning } : {}),
        })),
        summary: Array.from(voteCounts.entries()).map(([decision, data]) => ({
          decision,
          count: data.count,
          weightedCount: data.weighted,
          voters: data.voters,
        })),
      };
    },
  });

  const changeVote = tool({
    name: 'change_vote',
    description: 'Change your previous vote in the current round',
    parameters: z.object({
      newDecision: z.string().describe('Your new decision/vote'),
      reasoning: z.string().optional().describe('Reasoning for changing your vote'),
    }),
    execute: async ({ newDecision, reasoning }) => {
      const consensusState = safeReadConsensus<{
        currentRound: number;
        votes: Vote[];
      }>(blackboard);

      if (!consensusState) {
        return {
          success: false,
          error: 'No active consensus session',
        };
      }

      const previousVoteIndex = consensusState.votes.findIndex(
        (v) => v.agentName === currentAgent && v.round === consensusState.currentRound
      );

      const previousDecision =
        previousVoteIndex >= 0 ? consensusState.votes[previousVoteIndex].decision : null;

      if (previousVoteIndex >= 0) {
        consensusState.votes.splice(previousVoteIndex, 1);
      }

      const vote: Vote = {
        agentName: currentAgent,
        decision: newDecision,
        reasoning,
        weight: agentWeight,
        round: consensusState.currentRound,
        timestamp: Date.now(),
      };
      consensusState.votes.push(vote);
      blackboard.write('consensus', consensusState, currentAgent);

      events.emit(
        'consensus:vote:changed',
        {
          agent: currentAgent,
          previousDecision,
          newDecision,
          round: consensusState.currentRound,
        },
        currentAgent
      );

      return {
        success: true,
        previousDecision,
        newDecision,
        round: consensusState.currentRound,
      };
    },
  });

  const getConsensusStatus = tool({
    name: 'get_consensus_status',
    description: 'Get the current status of the consensus session',
    parameters: z.object({}),
    execute: async () => {
      const consensusState = safeReadConsensus<{
        topic: string;
        currentRound: number;
        maxRounds: number;
        votes: Vote[];
        threshold: number;
        resolution: string;
      }>(blackboard);

      if (!consensusState) {
        return {
          active: false,
          error: 'No active consensus session',
        };
      }

      const currentRoundVotes = consensusState.votes.filter(
        (v) => v.round === consensusState.currentRound
      );

      const isWeighted = consensusState.resolution === 'weighted';
      const voteCounts = new Map<string, { count: number; weighted: number }>();
      let totalWeight = 0;

      for (const vote of currentRoundVotes) {
        const key = vote.decision.toLowerCase().trim();
        const existing = voteCounts.get(key) ?? { count: 0, weighted: 0 };
        existing.count++;
        existing.weighted += vote.weight;
        totalWeight += vote.weight;
        voteCounts.set(key, existing);
      }

      const totalVotes = currentRoundVotes.length;
      let leadingDecision = '';
      let leadingScore = 0;

      for (const [decision, data] of voteCounts) {
        const score = isWeighted ? data.weighted : data.count;
        if (score > leadingScore) {
          leadingScore = score;
          leadingDecision = decision;
        }
      }

      const denominator = isWeighted ? totalWeight : totalVotes;
      const consensusRatio = denominator > 0 ? leadingScore / denominator : 0;
      const wouldReachConsensus = consensusRatio >= consensusState.threshold;

      return {
        active: true,
        topic: consensusState.topic,
        currentRound: consensusState.currentRound,
        maxRounds: consensusState.maxRounds,
        roundsRemaining: consensusState.maxRounds - consensusState.currentRound,
        threshold: consensusState.threshold,
        resolution: consensusState.resolution,
        currentVotes: totalVotes,
        leadingDecision,
        leadingVotes: leadingScore,
        consensusRatio: Math.round(consensusRatio * 100) / 100,
        wouldReachConsensus,
        hasVoted: currentRoundVotes.some((v) => v.agentName === currentAgent),
      };
    },
  });

  return {
    castVote,
    getVotes,
    changeVote,
    getConsensusStatus,
  };
}

export type VotingTools = ReturnType<typeof createVotingTools>;
