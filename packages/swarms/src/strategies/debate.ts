/**
 * Debate strategy - Agents argue positions, moderator synthesizes
 */

import type {
  SwarmRunOptions,
  StrategyResult,
  DebateConfig,
  RunResult,
  SwarmMessage,
} from '@cogitator/types';
import { BaseStrategy } from './base.js';
import type { SwarmCoordinator } from '../coordinator.js';

export class DebateStrategy extends BaseStrategy {
  private config: DebateConfig;

  constructor(coordinator: SwarmCoordinator, config: DebateConfig) {
    super(coordinator);
    this.config = {
      format: 'structured',
      ...config,
    };
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();
    const debateTranscript: SwarmMessage[] = [];

    const advocates = this.coordinator.getAgents().filter(
      (a) => a.metadata.role === 'advocate'
    );
    const critics = this.coordinator.getAgents().filter(
      (a) => a.metadata.role === 'critic'
    );
    const moderators = this.coordinator.getAgents().filter(
      (a) => a.metadata.role === 'moderator'
    );

    let debaters = [...advocates, ...critics];
    if (debaters.length === 0) {
      debaters = this.coordinator.getAgents().filter(
        (a) => a.metadata.role !== 'moderator'
      );
    }

    if (debaters.length < 2) {
      throw new Error('Debate strategy requires at least 2 debating agents');
    }

    const moderator = moderators.length > 0 ? moderators[0] : null;

    this.coordinator.blackboard.write('debate', {
      topic: options.input,
      rounds: this.config.rounds,
      currentRound: 0,
      arguments: [],
    }, 'system');

    for (let round = 1; round <= this.config.rounds; round++) {
      this.coordinator.events.emit('debate:round', { round, total: this.config.rounds });

      const debateState = this.coordinator.blackboard.read<{ arguments: unknown[] }>('debate');
      this.coordinator.blackboard.write('debate', {
        ...debateState,
        currentRound: round,
      }, 'system');

      for (const debater of debaters) {
        const previousArguments = this.getPreviousArguments(debateTranscript, round);

        const debaterContext = {
          ...options.context,
          debateContext: {
            round,
            totalRounds: this.config.rounds,
            role: debater.metadata.role ?? 'debater',
            previousArguments,
            format: this.config.format,
          },
          debateInstructions: this.buildDebateInstructions(
            debater.metadata.role ?? 'debater',
            round,
            this.config.rounds,
            previousArguments
          ),
        };

        const input = round === 1
          ? options.input
          : `Continue the debate on: ${options.input}\n\nPrevious arguments:\n${previousArguments}`;

        this.coordinator.events.emit('debate:turn', {
          round,
          agent: debater.agent.name,
          role: debater.metadata.role,
        }, debater.agent.name);

        const result = await this.coordinator.runAgent(
          debater.agent.name,
          input,
          debaterContext
        );
        agentResults.set(`${debater.agent.name}_round${round}`, result);

        const message: SwarmMessage = {
          id: `debate_${round}_${debater.agent.name}`,
          swarmId: '',
          from: debater.agent.name,
          to: 'broadcast',
          type: 'notification',
          content: result.output,
          channel: 'debate',
          timestamp: Date.now(),
          metadata: { round, role: debater.metadata.role },
        };
        debateTranscript.push(message);

        const currentDebate = this.coordinator.blackboard.read<{ arguments: unknown[] }>('debate');
        currentDebate.arguments.push({
          agent: debater.agent.name,
          role: debater.metadata.role,
          round,
          argument: result.output,
        });
        this.coordinator.blackboard.write('debate', currentDebate, debater.agent.name);
      }
    }

    let finalOutput: string;
    let moderatorResult: RunResult | undefined;

    if (moderator) {
      const synthesisInput = `
Synthesize the following debate on the topic: "${options.input}"

Debate transcript:
${debateTranscript.map((m) => `[${m.metadata?.role ?? m.from}]: ${m.content}`).join('\n\n')}

Please provide:
1. A balanced summary of the key arguments from each side
2. Points of agreement and disagreement
3. Your assessment of the strongest arguments
4. A final recommendation or conclusion
`.trim();

      moderatorResult = await this.coordinator.runAgent(
        moderator.agent.name,
        synthesisInput,
        {
          ...options.context,
          moderatorContext: {
            debateRounds: this.config.rounds,
            participantCount: debaters.length,
            format: this.config.format,
          },
        }
      );
      agentResults.set(moderator.agent.name, moderatorResult);
      finalOutput = moderatorResult.output;
    } else {
      finalOutput = this.synthesizeDebate(debateTranscript, options.input);
    }

    return {
      output: finalOutput,
      structured: moderatorResult?.structured,
      agentResults,
      debateTranscript,
    };
  }

  private getPreviousArguments(
    transcript: SwarmMessage[],
    currentRound: number
  ): string {
    const previousMessages = transcript.filter(
      (m) => (m.metadata?.round as number) < currentRound
    );

    if (previousMessages.length === 0) return '';

    return previousMessages
      .map((m) => `[${m.metadata?.role ?? m.from}]: ${m.content}`)
      .join('\n\n');
  }

  private buildDebateInstructions(
    role: string,
    round: number,
    totalRounds: number,
    previousArguments: string
  ): string {
    const roleInstructions = {
      advocate: 'You are arguing IN FAVOR of the proposition. Find compelling reasons to support it.',
      critic: 'You are arguing AGAINST the proposition. Find weaknesses and raise objections.',
      debater: 'Present your perspective on the topic with well-reasoned arguments.',
    };

    const instruction = roleInstructions[role as keyof typeof roleInstructions] ?? roleInstructions.debater;

    return `
${instruction}

This is round ${round} of ${totalRounds}.
${previousArguments ? '\nConsider and respond to the previous arguments when formulating your position.' : ''}

Guidelines:
- Be concise but thorough
- Support your claims with reasoning
- Address counterarguments if applicable
- Maintain a professional and constructive tone
${this.config.format === 'structured' ? '- Structure your argument with clear points' : ''}
`.trim();
  }

  private synthesizeDebate(transcript: SwarmMessage[], topic: string): string {
    const argumentsByAgent: Record<string, string[]> = {};

    for (const msg of transcript) {
      const agent = msg.from;
      if (!argumentsByAgent[agent]) {
        argumentsByAgent[agent] = [];
      }
      argumentsByAgent[agent].push(msg.content);
    }

    let summary = `Debate Summary on: "${topic}"\n\n`;

    for (const [agent, args] of Object.entries(argumentsByAgent)) {
      summary += `=== ${agent} ===\n`;
      args.forEach((arg, i) => {
        summary += `Round ${i + 1}: ${arg.slice(0, 200)}...\n`;
      });
      summary += '\n';
    }

    return summary;
  }
}
