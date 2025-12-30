/**
 * Consensus strategy - Agents vote and reach agreement
 */

import type {
  SwarmRunOptions,
  StrategyResult,
  ConsensusConfig,
  RunResult,
  SwarmMessage,
  SwarmAgent,
} from '@cogitator/types';
import { BaseStrategy } from './base';
import type { SwarmCoordinator } from '../coordinator';

interface Vote {
  agentName: string;
  decision: string;
  reasoning?: string;
  weight: number;
  round: number;
}

interface VoteCount {
  decision: string;
  count: number;
  weightedCount: number;
  voters: string[];
}

export class ConsensusStrategy extends BaseStrategy {
  private config: ConsensusConfig;

  constructor(coordinator: SwarmCoordinator, config: ConsensusConfig) {
    super(coordinator);
    this.config = config;
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();
    const allVotes: Vote[] = [];
    const discussionTranscript: SwarmMessage[] = [];

    const agents = this.coordinator.getAgents();
    if (agents.length < 2) {
      throw new Error('Consensus strategy requires at least 2 agents');
    }

    const supervisors = this.coordinator.getAgentsByRole('supervisor');
    const supervisor = supervisors.length > 0 ? supervisors[0] : null;

    this.coordinator.blackboard.write('consensus', {
      topic: options.input,
      maxRounds: this.config.maxRounds,
      currentRound: 0,
      votes: [],
      resolution: this.config.resolution,
      threshold: this.config.threshold,
    }, 'system');

    let consensusReached = false;
    let winningDecision: string | null = null;
    let finalRound = 0;

    for (let round = 1; round <= this.config.maxRounds && !consensusReached; round++) {
      finalRound = round;
      this.coordinator.events.emit('consensus:round', { round, total: this.config.maxRounds });

      const consensusState = this.coordinator.blackboard.read<{ votes: Vote[] }>('consensus');
      this.coordinator.blackboard.write('consensus', {
        ...consensusState,
        currentRound: round,
      }, 'system');

      const roundVotes: Vote[] = [];

      const previousDiscussion = this.getPreviousDiscussion(discussionTranscript, round);

      for (const swarmAgent of agents) {
        if (swarmAgent.metadata.role === 'supervisor') continue;

        const agentContext = {
          ...options.context,
          consensusContext: {
            round,
            totalRounds: this.config.maxRounds,
            resolution: this.config.resolution,
            threshold: this.config.threshold,
            previousVotes: this.summarizeVotes(allVotes.filter(v => v.round < round)),
            previousDiscussion,
          },
          consensusInstructions: this.buildConsensusInstructions(swarmAgent, round),
        };

        const input = round === 1
          ? `Consider the following and provide your decision:\n\n${options.input}\n\nProvide your vote as: VOTE: [your decision]\nFollowed by your reasoning.`
          : `Continue the consensus discussion on: ${options.input}\n\nPrevious votes and discussion:\n${previousDiscussion}\n\nProvide your updated vote as: VOTE: [your decision]\nFollowed by your reasoning.`;

        this.coordinator.events.emit('consensus:turn', {
          round,
          agent: swarmAgent.agent.name,
        }, swarmAgent.agent.name);

        const result = await this.coordinator.runAgent(
          swarmAgent.agent.name,
          input,
          agentContext
        );
        agentResults.set(`${swarmAgent.agent.name}_round${round}`, result);

        const vote = this.extractVote(result.output, swarmAgent, round);
        if (vote) {
          roundVotes.push(vote);
          allVotes.push(vote);
        }

        const message: SwarmMessage = {
          id: `consensus_${round}_${swarmAgent.agent.name}`,
          swarmId: '',
          from: swarmAgent.agent.name,
          to: 'broadcast',
          type: 'notification',
          content: result.output,
          channel: 'consensus',
          timestamp: Date.now(),
          metadata: { round, vote: vote?.decision },
        };
        discussionTranscript.push(message);
      }

      const updatedState = this.coordinator.blackboard.read<{ votes: Vote[] }>('consensus');
      updatedState.votes = allVotes;
      this.coordinator.blackboard.write('consensus', updatedState, 'system');

      const consensusResult = this.checkConsensus(roundVotes, agents.filter(a => a.metadata.role !== 'supervisor'));
      if (consensusResult.reached) {
        consensusReached = true;
        winningDecision = consensusResult.decision;
        this.coordinator.events.emit('consensus:reached', {
          round,
          decision: winningDecision,
          votes: consensusResult.voteCounts,
        });
      }
    }

    let finalOutput: string;

    if (consensusReached && winningDecision) {
      finalOutput = this.buildConsensusOutput(winningDecision, allVotes, finalRound, true);
    } else {
      switch (this.config.onNoConsensus) {
        case 'supervisor-decides':
          if (supervisor) {
            const supervisorResult = await this.runSupervisorDecision(
              supervisor,
              options,
              allVotes,
              discussionTranscript
            );
            agentResults.set(supervisor.agent.name, supervisorResult);
            finalOutput = supervisorResult.output;
          } else {
            finalOutput = this.buildConsensusOutput(null, allVotes, finalRound, false);
          }
          break;

        case 'escalate':
          finalOutput = `ESCALATION REQUIRED\n\n${this.buildConsensusOutput(null, allVotes, finalRound, false)}\n\nNo consensus reached after ${this.config.maxRounds} rounds. Please escalate to human decision-maker.`;
          break;

        case 'fail':
        default:
          throw new Error(`Consensus not reached after ${this.config.maxRounds} rounds`);
      }
    }

    const votesMap = new Map<string, unknown>();
    for (const vote of allVotes) {
      votesMap.set(`${vote.agentName}_round${vote.round}`, {
        decision: vote.decision,
        reasoning: vote.reasoning,
        weight: vote.weight,
      });
    }

    return {
      output: finalOutput,
      agentResults,
      votes: votesMap,
    };
  }

  private extractVote(output: string, agent: SwarmAgent, round: number): Vote | null {
    const voteMatch = /VOTE:\s*([^\n]+)/i.exec(output);
    if (!voteMatch) {
      const decisionMatch = /(?:decision|vote|choose|select):\s*([^\n]+)/i.exec(output);
      if (!decisionMatch) return null;

      return {
        agentName: agent.agent.name,
        decision: decisionMatch[1].trim(),
        reasoning: output,
        weight: this.getAgentWeight(agent),
        round,
      };
    }

    return {
      agentName: agent.agent.name,
      decision: voteMatch[1].trim(),
      reasoning: output.replace(voteMatch[0], '').trim(),
      weight: this.getAgentWeight(agent),
      round,
    };
  }

  private getAgentWeight(agent: SwarmAgent): number {
    if (this.config.weights?.[agent.agent.name] !== undefined) {
      return this.config.weights[agent.agent.name];
    }
    if (agent.metadata.weight !== undefined) {
      return agent.metadata.weight;
    }
    return 1;
  }

  private checkConsensus(
    votes: Vote[],
    agents: SwarmAgent[]
  ): { reached: boolean; decision: string | null; voteCounts: VoteCount[] } {
    if (votes.length === 0) {
      return { reached: false, decision: null, voteCounts: [] };
    }

    const voteCounts = new Map<string, VoteCount>();

    for (const vote of votes) {
      const normalized = vote.decision.toLowerCase().trim();
      const existing = voteCounts.get(normalized);

      if (existing) {
        existing.count++;
        existing.weightedCount += vote.weight;
        existing.voters.push(vote.agentName);
      } else {
        voteCounts.set(normalized, {
          decision: vote.decision,
          count: 1,
          weightedCount: vote.weight,
          voters: [vote.agentName],
        });
      }
    }

    const countsArray = Array.from(voteCounts.values());
    const totalVotes = votes.length;
    const totalWeight = votes.reduce((sum, v) => sum + v.weight, 0);

    switch (this.config.resolution) {
      case 'unanimous': {
        if (countsArray.length === 1 && countsArray[0].count === agents.length) {
          return { reached: true, decision: countsArray[0].decision, voteCounts: countsArray };
        }
        return { reached: false, decision: null, voteCounts: countsArray };
      }

      case 'weighted': {
        const sorted = countsArray.sort((a, b) => b.weightedCount - a.weightedCount);
        const topOption = sorted[0];
        const weightRatio = topOption.weightedCount / totalWeight;

        if (weightRatio >= this.config.threshold) {
          return { reached: true, decision: topOption.decision, voteCounts: countsArray };
        }
        return { reached: false, decision: null, voteCounts: countsArray };
      }

      case 'majority':
      default: {
        const sorted = countsArray.sort((a, b) => b.count - a.count);
        const topOption = sorted[0];
        const voteRatio = topOption.count / totalVotes;

        if (voteRatio >= this.config.threshold) {
          return { reached: true, decision: topOption.decision, voteCounts: countsArray };
        }
        return { reached: false, decision: null, voteCounts: countsArray };
      }
    }
  }

  private summarizeVotes(votes: Vote[]): string {
    if (votes.length === 0) return 'No previous votes.';

    const byAgent = new Map<string, Vote[]>();
    for (const vote of votes) {
      const existing = byAgent.get(vote.agentName) ?? [];
      existing.push(vote);
      byAgent.set(vote.agentName, existing);
    }

    return Array.from(byAgent.entries())
      .map(([agent, agentVotes]) => {
        const lastVote = agentVotes[agentVotes.length - 1];
        return `${agent}: ${lastVote.decision}`;
      })
      .join('\n');
  }

  private getPreviousDiscussion(transcript: SwarmMessage[], currentRound: number): string {
    const previousMessages = transcript.filter(
      (m) => (m.metadata?.round as number) < currentRound
    );

    if (previousMessages.length === 0) return '';

    return previousMessages
      .map((m) => `[${m.from}]: ${m.content}`)
      .join('\n\n');
  }

  private buildConsensusInstructions(agent: SwarmAgent, round: number): string {
    const resolutionDesc = {
      majority: `A decision wins if it receives ${Math.round(this.config.threshold * 100)}% or more of the votes.`,
      unanimous: 'All agents must agree on the same decision.',
      weighted: `A decision wins if its weighted vote reaches ${Math.round(this.config.threshold * 100)}% of total weight.`,
    };

    return `
You are participating in a consensus decision-making process.

Round ${round} of ${this.config.maxRounds}
Resolution: ${this.config.resolution} - ${resolutionDesc[this.config.resolution]}

Your weight in this vote: ${this.getAgentWeight(agent)}

Instructions:
1. Consider the topic carefully
2. Review previous votes and reasoning if available
3. Provide your vote in the format: VOTE: [your decision]
4. Explain your reasoning
5. If you're changing your vote from a previous round, explain why

Be constructive and aim for consensus while maintaining your expert judgment.
`.trim();
  }

  private async runSupervisorDecision(
    supervisor: SwarmAgent,
    options: SwarmRunOptions,
    votes: Vote[],
    transcript: SwarmMessage[]
  ): Promise<RunResult> {
    const voteSummary = this.summarizeVotes(votes);
    const discussionSummary = transcript
      .map((m) => `[${m.from}]: ${m.content.slice(0, 300)}...`)
      .join('\n\n');

    const input = `
As the supervisor, the team has not reached consensus after ${this.config.maxRounds} rounds.

Original topic: ${options.input}

Vote summary:
${voteSummary}

Discussion highlights:
${discussionSummary}

Please make the final decision and explain your reasoning.
Provide your decision as: FINAL DECISION: [your decision]
`.trim();

    return this.coordinator.runAgent(supervisor.agent.name, input, {
      ...options.context,
      supervisorContext: {
        noConsensusEscalation: true,
        rounds: this.config.maxRounds,
        totalVotes: votes.length,
      },
    });
  }

  private buildConsensusOutput(
    decision: string | null,
    votes: Vote[],
    rounds: number,
    reached: boolean
  ): string {
    const votesByRound = new Map<number, Vote[]>();
    for (const vote of votes) {
      const existing = votesByRound.get(vote.round) ?? [];
      existing.push(vote);
      votesByRound.set(vote.round, existing);
    }

    let output = reached
      ? `CONSENSUS REACHED\n\nDecision: ${decision}\n\n`
      : `NO CONSENSUS\n\n`;

    output += `Rounds: ${rounds}\nResolution method: ${this.config.resolution}\nThreshold: ${Math.round(this.config.threshold * 100)}%\n\n`;

    output += '=== Vote History ===\n\n';
    for (const [round, roundVotes] of votesByRound) {
      output += `Round ${round}:\n`;
      for (const vote of roundVotes) {
        output += `  ${vote.agentName}: ${vote.decision}${vote.weight !== 1 ? ` (weight: ${vote.weight})` : ''}\n`;
      }
      output += '\n';
    }

    const finalVotes = votes.filter(v => v.round === rounds);
    const voteCounts = new Map<string, number>();
    for (const vote of finalVotes) {
      const key = vote.decision.toLowerCase().trim();
      voteCounts.set(key, (voteCounts.get(key) ?? 0) + 1);
    }

    output += '=== Final Vote Tally ===\n';
    for (const [decision, count] of voteCounts) {
      output += `  ${decision}: ${count} votes\n`;
    }

    return output;
  }
}
