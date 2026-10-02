/**
 * SwarmCoordinator - In-process execution engine for multi-agent swarms
 */

import { nanoid } from 'nanoid';
import type { Cogitator } from '@cogitator-ai/core';
import type { SwarmConfig, RunResult } from '@cogitator-ai/types';
import {
  SwarmEventEmitterImpl,
  InMemoryMessageBus,
  InMemoryBlackboard,
} from './communication/index';
import { BaseSwarmCoordinator, type AgentRunRequest } from './base-coordinator';

export { computeBackoffDelay, type SwarmRunScope, type AgentRunRequest } from './base-coordinator';

export class SwarmCoordinator extends BaseSwarmCoordinator<
  InMemoryMessageBus,
  InMemoryBlackboard,
  SwarmEventEmitterImpl
> {
  private cogitator: Cogitator;

  constructor(cogitator: Cogitator, config: SwarmConfig) {
    super(config, `swarm_${nanoid(12)}`, {
      messageBus: new InMemoryMessageBus(config.messaging ?? { enabled: true, protocol: 'direct' }),
      blackboard: new InMemoryBlackboard(
        config.blackboard ?? { enabled: true, sections: {}, trackHistory: true }
      ),
      events: new SwarmEventEmitterImpl(),
    });
    this.cogitator = cogitator;
  }

  protected executeRun(request: AgentRunRequest): Promise<RunResult> {
    return this.cogitator.run(request.agent, {
      input: request.input,
      context: request.context,
      saveHistory: request.saveHistory,
      signal: request.signal,
      ...(request.threadId && { threadId: request.threadId }),
      ...(request.timeout !== undefined && { timeout: request.timeout }),
    });
  }
}
