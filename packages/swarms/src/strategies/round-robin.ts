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

    const selectedAgent = this.selectAgent(agents, options);

    this.coordinator.events.emit('round-robin:assigned', {
      agent: selectedAgent.agent.name,
      index: this.currentIndex,
      sticky: this.config.sticky,
    });

    this.coordinator.blackboard.write(
      'round-robin',
      {
        currentAgent: selectedAgent.agent.name,
        currentIndex: this.currentIndex,
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

    if (this.config.rotation === 'sequential' && !this.config.sticky) {
      this.currentIndex = (this.currentIndex + 1) % agents.length;
    }

    return {
      output: result.output,
      structured: result.structured,
      agentResults,
    };
  }

  private selectAgent(agents: SwarmAgent[], options: SwarmRunOptions): SwarmAgent {
    if (this.config.sticky && this.config.stickyKey) {
      const key = this.config.stickyKey(options.input);
      const existingAssignment = this.stickyAssignments.get(key);

      if (existingAssignment) {
        const agent = agents.find((a) => a.agent.name === existingAssignment);
        if (agent) {
          return agent;
        }
        this.stickyAssignments.delete(key);
      }

      const selectedAgent = this.getNextAgent(agents);
      this.stickyAssignments.set(key, selectedAgent.agent.name);
      return selectedAgent;
    }

    return this.getNextAgent(agents);
  }

  private getNextAgent(agents: SwarmAgent[]): SwarmAgent {
    if (this.config.rotation === 'random') {
      const randomIndex = Math.floor(Math.random() * agents.length);
      this.currentIndex = randomIndex;
      return agents[randomIndex];
    }

    if (this.currentIndex >= agents.length) {
      this.currentIndex = 0;
    }

    return agents[this.currentIndex];
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
