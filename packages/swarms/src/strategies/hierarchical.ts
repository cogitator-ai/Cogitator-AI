/**
 * Hierarchical strategy - Supervisor delegates to workers
 */

import type {
  SwarmRunOptions,
  StrategyResult,
  HierarchicalConfig,
  RunResult,
} from '@cogitator/types';
import { BaseStrategy } from './base';
import type { SwarmCoordinator } from '../coordinator';

export class HierarchicalStrategy extends BaseStrategy {
  private config: HierarchicalConfig;

  constructor(coordinator: SwarmCoordinator, config?: HierarchicalConfig) {
    super(coordinator);
    this.config = {
      maxDelegationDepth: 3,
      workerCommunication: false,
      routeThrough: 'supervisor',
      visibility: 'full',
      ...config,
    };
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();

    const supervisors = this.coordinator.getAgents().filter(
      (a) => a.metadata.role === 'supervisor'
    );
    if (supervisors.length === 0) {
      throw new Error('Hierarchical strategy requires a supervisor agent');
    }
    const supervisor = supervisors[0];

    const workers = this.coordinator.getAgents().filter(
      (a) => a.metadata.role === 'worker'
    );

    const workerInfo = workers.map((w) => ({
      name: w.agent.name,
      description: w.agent.config.description ?? w.agent.config.instructions.slice(0, 200),
      expertise: w.metadata.expertise ?? [],
    }));

    const supervisorContext = {
      ...options.context,
      availableWorkers: workerInfo,
      hierarchyConfig: {
        maxDelegationDepth: this.config.maxDelegationDepth,
        workerCommunication: this.config.workerCommunication,
      },
      delegationInstructions: this.buildDelegationInstructions(workerInfo),
    };

    this.coordinator.blackboard.write('tasks', [], 'system');
    this.coordinator.blackboard.write('workerResults', {}, 'system');

    const supervisorResult = await this.coordinator.runAgent(
      supervisor.agent.name,
      options.input,
      supervisorContext
    );
    agentResults.set(supervisor.agent.name, supervisorResult);

    for (const worker of workers) {
      if (worker.lastResult) {
        agentResults.set(worker.agent.name, worker.lastResult);
      }
    }

    return {
      output: supervisorResult.output,
      structured: supervisorResult.structured,
      agentResults,
    };
  }

  private buildDelegationInstructions(
    workerInfo: { name: string; description: string; expertise: string[] }[]
  ): string {
    const workerList = workerInfo
      .map((w) => {
        const expertise = w.expertise.length > 0 ? ` (expertise: ${w.expertise.join(', ')})` : '';
        return `- ${w.name}: ${w.description}${expertise}`;
      })
      .join('\n');

    return `
You are a supervisor managing a team of workers. You can delegate tasks to workers and coordinate their work.

Available workers:
${workerList}

You can use the following tools to manage your team:
- delegate_task(worker, task): Assign a task to a specific worker
- check_progress(worker): Check the status and last output of a worker
- request_revision(worker, feedback): Ask a worker to revise their work

Your job is to:
1. Analyze the incoming task
2. Break it down into subtasks suitable for your workers
3. Delegate subtasks to appropriate workers
4. Coordinate and synthesize their outputs
5. Provide a final response

Important:
- Workers cannot see each other's outputs unless you share them via your coordination
- You are responsible for quality control and final output
- If a worker's output is insufficient, request a revision
`.trim();
  }
}
