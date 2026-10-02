/**
 * Hierarchical strategy - Supervisor delegates to workers
 */

import type {
  SwarmRunOptions,
  StrategyResult,
  HierarchicalConfig,
  RunResult,
  SwarmCoordinatorInterface,
} from '@cogitator-ai/types';
import { BaseStrategy } from './base.js';
import { HIERARCHY_SECTION, type HierarchyPolicy } from '../shared/hierarchy.js';

type ResolvedHierarchicalConfig = Required<HierarchicalConfig>;

export class HierarchicalStrategy extends BaseStrategy {
  private config: ResolvedHierarchicalConfig;

  constructor(coordinator: SwarmCoordinatorInterface, config?: HierarchicalConfig) {
    super(coordinator);
    this.config = {
      maxDelegationDepth: config?.maxDelegationDepth ?? 3,
      workerCommunication: config?.workerCommunication ?? false,
      routeThrough: config?.routeThrough ?? 'supervisor',
      visibility: config?.visibility ?? 'full',
    };
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();

    const supervisors = this.coordinator.getAgentsByRole('supervisor');
    if (supervisors.length === 0) {
      throw new Error('Hierarchical strategy requires a supervisor agent');
    }
    const supervisor = supervisors[0];

    const workers = this.coordinator.getAgentsByRole('worker');

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
        routeThrough: this.config.routeThrough,
        visibility: this.config.visibility,
      },
      delegationInstructions: this.buildDelegationInstructions(workerInfo),
    };

    const policy: HierarchyPolicy = {
      supervisor: supervisor.agent.name,
      maxDelegationDepth: this.config.maxDelegationDepth,
      workerCommunication: this.config.workerCommunication,
      routeThrough: this.config.routeThrough,
      visibility: this.config.visibility,
      depths: { [supervisor.agent.name]: 0 },
    };

    this.coordinator.blackboard.write(HIERARCHY_SECTION, policy, 'system');
    this.coordinator.blackboard.write('tasks', [], 'system');
    this.coordinator.blackboard.write('workerResults', {}, 'system');

    const resultsBefore = new Map(workers.map((w) => [w.agent.name, w.lastResult]));

    const supervisorResult = await this.coordinator.runAgent(
      supervisor.agent.name,
      options.input,
      supervisorContext
    );
    agentResults.set(supervisor.agent.name, supervisorResult);

    for (const worker of workers) {
      const latest = worker.lastResult;
      if (latest && latest !== resultsBefore.get(worker.agent.name)) {
        agentResults.set(worker.agent.name, latest);
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

    const communication = this.config.workerCommunication
      ? this.config.routeThrough === 'direct'
        ? 'Workers may message each other directly.'
        : 'Workers may only message you; relay information between them yourself.'
      : "Workers cannot see each other's outputs unless you share them via your coordination.";

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
- ${communication}
- Delegation chains are limited to ${this.config.maxDelegationDepth} level(s)
- You are responsible for quality control and final output
- If a worker's output is insufficient, request a revision
`.trim();
  }
}
