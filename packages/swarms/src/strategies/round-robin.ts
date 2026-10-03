/**
 * Round-robin strategy - Rotate task assignment among agents
 */

import type {
  SwarmRunOptions,
  StrategyResult,
  RoundRobinConfig,
  RunResult,
  SwarmAgent,
  SwarmCoordinatorInterface,
} from '@cogitator-ai/types';
import { BaseStrategy } from './base.js';

interface AgentSelection {
  swarmAgent: SwarmAgent;
  index: number;
  /** The agent was picked from the rotation rather than reused from a sticky assignment */
  rotated: boolean;
}

export class RoundRobinStrategy extends BaseStrategy {
  private config: RoundRobinConfig;
  private currentIndex = 0;
  private stickyAssignments = new Map<string, string>();

  constructor(coordinator: SwarmCoordinatorInterface, config?: RoundRobinConfig) {
    super(coordinator);
    this.config = {
      sticky: false,
      rotation: 'sequential',
      ...config,
    };
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();
    const agents = this.coordinator.getAgents();

    if (agents.length === 0) {
      throw new Error('Round-robin strategy requires at least 1 agent');
    }

    const selection = this.selectAgent(agents, options);
    const selectedAgent = selection.swarmAgent;

    this.coordinator.events.emit('round-robin:assigned', {
      agent: selectedAgent.agent.name,
      index: selection.index,
      sticky: this.config.sticky,
    });

    this.coordinator.blackboard.write(
      'round-robin',
      {
        currentAgent: selectedAgent.agent.name,
        currentIndex: selection.index,
        totalAgents: agents.length,
        stickyEnabled: this.config.sticky,
      },
      'system'
    );

    const agentContext = {
      ...options.context,
      roundRobinContext: {
        selectedAgent: selectedAgent.agent.name,
        totalAgents: agents.length,
        isSticky: this.config.sticky,
        rotation: this.config.rotation,
      },
    };

    const result = await this.coordinator.runAgent(
      selectedAgent.agent.name,
      options.input,
      agentContext
    );
    agentResults.set(selectedAgent.agent.name, result);

    if (this.config.rotation === 'sequential' && selection.rotated) {
      this.currentIndex = (selection.index + 1) % agents.length;
    }

    return {
      output: result.output,
      structured: result.structured,
      agentResults,
    };
  }

  /**
   * A sticky key that is already assigned keeps its agent; every other run takes the next
   * agent of the rotation (and a new sticky key is assigned to it).
   */
  private selectAgent(agents: SwarmAgent[], options: SwarmRunOptions): AgentSelection {
    if (this.config.sticky && this.config.stickyKey) {
      const key = this.config.stickyKey(options.input);
      const existingAssignment = this.stickyAssignments.get(key);

      if (existingAssignment) {
        const index = agents.findIndex((a) => a.agent.name === existingAssignment);
        if (index >= 0) {
          return { swarmAgent: agents[index], index, rotated: false };
        }
        this.stickyAssignments.delete(key);
      }

      const selection = this.getNextAgent(agents);
      this.stickyAssignments.set(key, selection.swarmAgent.agent.name);
      return selection;
    }

    return this.getNextAgent(agents);
  }

  private getNextAgent(agents: SwarmAgent[]): AgentSelection {
    if (this.config.rotation === 'random') {
      const randomIndex = Math.floor(Math.random() * agents.length);
      this.currentIndex = randomIndex;
      return { swarmAgent: agents[randomIndex], index: randomIndex, rotated: true };
    }

    if (this.currentIndex >= agents.length) {
      this.currentIndex = 0;
    }

    return { swarmAgent: agents[this.currentIndex], index: this.currentIndex, rotated: true };
  }

  /**
   * Reset the rotation index
   */
  reset(): void {
    this.currentIndex = 0;
    this.stickyAssignments.clear();
  }

  /**
   * Get current rotation state
   */
  getState(): {
    currentIndex: number;
    stickyAssignments: Record<string, string>;
  } {
    return {
      currentIndex: this.currentIndex,
      stickyAssignments: Object.fromEntries(this.stickyAssignments),
    };
  }
}
