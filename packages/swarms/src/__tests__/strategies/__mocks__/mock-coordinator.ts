import type {
  SwarmCoordinatorInterface,
  SwarmAgent,
  SwarmAgentMetadata,
  RunResult,
  SwarmAgentRunOptions,
  MessageBus,
  Blackboard,
  SwarmEventEmitter,
} from '@cogitator-ai/types';
import {
  InMemoryMessageBus,
  InMemoryBlackboard,
  SwarmEventEmitterImpl,
} from '../../../communication';
import { createMockRunResult, type ResponseGenerator } from './mock-helpers';

export interface AgentCall {
  agent: string;
  input: string;
  context?: Record<string, unknown>;
  options?: SwarmAgentRunOptions;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getCallContext(
  call: AgentCall | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = call?.context?.[key];
  return isRecord(value) ? value : undefined;
}

export class MockCoordinator implements SwarmCoordinatorInterface {
  private responses = new Map<string, RunResult | ResponseGenerator>();
  private agents = new Map<string, SwarmAgent>();
  private _calls: AgentCall[] = [];

  messageBus: MessageBus;
  blackboard: Blackboard;
  events: SwarmEventEmitter;

  constructor() {
    this.messageBus = new InMemoryMessageBus({ enabled: true, protocol: 'direct' });
    this.blackboard = new InMemoryBlackboard({ enabled: true, sections: {}, trackHistory: true });
    this.events = new SwarmEventEmitterImpl();
  }

  setAgentResponse(name: string, response: RunResult | string | ResponseGenerator): void {
    if (typeof response === 'string') {
      this.responses.set(name, createMockRunResult(response));
    } else if (typeof response === 'function') {
      this.responses.set(name, response);
    } else {
      this.responses.set(name, response);
    }
  }

  addAgent(swarmAgent: SwarmAgent): void {
    this.agents.set(swarmAgent.agent.name, swarmAgent);
  }

  getCalls(): AgentCall[] {
    return [...this._calls];
  }

  getCallsFor(agentName: string): AgentCall[] {
    return this._calls.filter((c) => c.agent === agentName);
  }

  getLastCall(): AgentCall | undefined {
    return this._calls[this._calls.length - 1];
  }

  getLastCallFor(agentName: string): AgentCall | undefined {
    const calls = this.getCallsFor(agentName);
    return calls[calls.length - 1];
  }

  clearCalls(): void {
    this._calls = [];
  }

  reset(): void {
    this._calls = [];
    this.responses.clear();
    this.agents.clear();
    (this.messageBus as InMemoryMessageBus).clear();
    (this.blackboard as InMemoryBlackboard).clear();
  }

  async runAgent(
    agentName: string,
    input: string,
    context?: Record<string, unknown>,
    options?: SwarmAgentRunOptions
  ): Promise<RunResult> {
    const swarmAgent = this.agents.get(agentName);
    if (!swarmAgent) {
      throw new Error(`Agent '${agentName}' not found in swarm`);
    }

    this._calls.push({
      agent: agentName,
      input,
      context,
      options,
      timestamp: Date.now(),
    });

    swarmAgent.state = 'running';

    const responseOrGenerator = this.responses.get(agentName);
    let result: RunResult;

    if (!responseOrGenerator) {
      result = createMockRunResult(`Default response from ${agentName}`, {
        agentId: swarmAgent.agent.id,
      });
    } else if (typeof responseOrGenerator === 'function') {
      const output = await responseOrGenerator(input, context);
      result = createMockRunResult(output, { agentId: swarmAgent.agent.id });
    } else {
      result = responseOrGenerator;
    }

    swarmAgent.state = 'completed';
    swarmAgent.lastResult = result;
    swarmAgent.tokenCount += result.usage.totalTokens;

    return result;
  }

  async runAgentsParallel(
    agents: { name: string; input: string; context?: Record<string, unknown> }[],
    _maxConcurrency?: number
  ): Promise<Map<string, RunResult>> {
    const results = new Map<string, RunResult>();

    const settled = await Promise.allSettled(
      agents.map(async ({ name, input, context }) => {
        const result = await this.runAgent(name, input, context);
        return { name, result };
      })
    );

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.set(s.value.name, s.value.result);
      }
    }

    return results;
  }

  getAgent(name: string): SwarmAgent | undefined {
    return this.agents.get(name);
  }

  getAgents(): SwarmAgent[] {
    return Array.from(this.agents.values());
  }

  getAgentsByRole(role: SwarmAgentMetadata['role']): SwarmAgent[] {
    return this.getAgents().filter((a) => a.metadata.role === role);
  }
}
