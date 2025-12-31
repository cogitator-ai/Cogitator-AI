/**
 * Agent class implementation
 */

import type { Agent as IAgent, AgentConfig, Tool } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export class Agent implements IAgent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.id = config.id ?? `agent_${nanoid(12)}`;
    this.name = config.name;
    this.config = {
      temperature: 0.7,
      maxIterations: 10,
      timeout: 120_000,
      ...config,
    };
  }

  get model(): string {
    return this.config.model;
  }

  get instructions(): string {
    return this.config.instructions;
  }

  get tools(): Tool[] {
    return this.config.tools ?? [];
  }

  clone(overrides: Partial<AgentConfig>): Agent {
    return new Agent({
      ...this.config,
      ...overrides,
    });
  }
}
