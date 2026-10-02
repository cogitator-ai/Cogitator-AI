/**
 * Swarm delegation tools for hierarchical task management
 */

import { z } from 'zod';
import { nanoid } from 'nanoid';
import { tool } from '@cogitator-ai/core';
import type { SwarmCoordinatorInterface, Blackboard } from '@cogitator-ai/types';
import {
  HIERARCHY_SECTION,
  applyVisibility,
  readHierarchyPolicy,
  type HierarchyPolicy,
} from '../shared/hierarchy.js';

type TaskStatus = 'delegated' | 'completed' | 'failed' | 'revised';

interface DelegatedTask {
  id: string;
  worker: string;
  task: string;
  status: TaskStatus;
  delegatedBy: string;
  timestamp: number;
}

function readSection<T>(blackboard: Blackboard, section: string, fallback: T): T {
  if (!blackboard.has(section)) return fallback;
  try {
    return blackboard.read<T>(section) ?? fallback;
  } catch {
    return fallback;
  }
}

function readTasks(blackboard: Blackboard): DelegatedTask[] {
  return [...readSection<DelegatedTask[]>(blackboard, 'tasks', [])];
}

function readWorkerResults(blackboard: Blackboard): Record<string, unknown> {
  return { ...readSection<Record<string, unknown>>(blackboard, 'workerResults', {}) };
}

function updateTaskStatus(
  blackboard: Blackboard,
  taskId: string,
  status: TaskStatus,
  writer: string
): void {
  const tasks = readTasks(blackboard).map((t) => (t.id === taskId ? { ...t, status } : t));
  blackboard.write('tasks', tasks, writer);
}

function recordWorkerResult(
  blackboard: Blackboard,
  taskId: string,
  output: string,
  writer: string
): void {
  const results = readWorkerResults(blackboard);
  results[taskId] = output;
  blackboard.write('workerResults', results, writer);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function createDelegationTools(
  coordinator: SwarmCoordinatorInterface,
  blackboard: Blackboard,
  currentAgent: string
) {
  const checkDelegationAllowed = (worker: string): string | null => {
    if (worker === currentAgent) {
      return 'You cannot delegate a task to yourself';
    }

    const policy = readHierarchyPolicy(blackboard);
    if (!policy) return null;

    if (worker === policy.supervisor) {
      return 'Tasks cannot be delegated to the supervisor';
    }

    const depth = policy.depths[currentAgent] ?? 0;
    if (depth >= policy.maxDelegationDepth) {
      return `Maximum delegation depth (${policy.maxDelegationDepth}) reached`;
    }

    return null;
  };

  const recordDelegationDepth = (worker: string): void => {
    const policy = readHierarchyPolicy(blackboard);
    if (!policy) return;

    const depth = (policy.depths[currentAgent] ?? 0) + 1;
    const updated: HierarchyPolicy = {
      ...policy,
      depths: { ...policy.depths, [worker]: Math.max(policy.depths[worker] ?? 0, depth) },
    };
    blackboard.write(HIERARCHY_SECTION, updated, currentAgent);
  };

  const visibleOutput = (output: string): string | undefined => {
    const policy = readHierarchyPolicy(blackboard);
    return applyVisibility(output, policy?.visibility ?? 'full');
  };

  const delegateTask = tool({
    name: 'delegate_task',
    description: 'Delegate a task to a worker agent',
    parameters: z.object({
      worker: z.string().describe('Name of the worker agent to delegate to'),
      task: z.string().describe('The task description to delegate'),
      context: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Additional context for the worker'),
      priority: z.enum(['high', 'normal', 'low']).optional().describe('Task priority'),
      waitForCompletion: z
        .boolean()
        .optional()
        .describe('Wait for worker to complete (default: true)'),
    }),
    execute: async ({ worker, task, context, priority = 'normal', waitForCompletion = true }) => {
      const workerAgent = coordinator.getAgent(worker);

      if (!workerAgent) {
        return {
          success: false,
          error: `Worker agent '${worker}' not found`,
          availableWorkers: coordinator.getAgentsByRole('worker').map((a) => a.agent.name),
        };
      }

      const refusal = checkDelegationAllowed(worker);
      if (refusal) {
        return { success: false, error: refusal };
      }

      const taskId = `task_${nanoid(10)}`;
      const tasks = readTasks(blackboard);
      tasks.push({
        id: taskId,
        worker,
        task,
        status: 'delegated',
        delegatedBy: currentAgent,
        timestamp: Date.now(),
      });
      blackboard.write('tasks', tasks, currentAgent);
      recordDelegationDepth(worker);

      const run = coordinator.runAgent(worker, task, {
        ...context,
        delegationContext: {
          delegatedBy: currentAgent,
          taskId,
          priority,
        },
      });

      if (!waitForCompletion) {
        run
          .then((result) => {
            updateTaskStatus(blackboard, taskId, 'completed', worker);
            recordWorkerResult(blackboard, taskId, result.output, worker);
          })
          .catch(() => {
            updateTaskStatus(blackboard, taskId, 'failed', worker);
          });

        return {
          success: true,
          taskId,
          worker,
          async: true,
          message: `Task delegated to ${worker}, running in background`,
        };
      }

      try {
        const result = await run;

        updateTaskStatus(blackboard, taskId, 'completed', worker);
        recordWorkerResult(blackboard, taskId, result.output, worker);

        return {
          success: true,
          taskId,
          worker,
          output: visibleOutput(result.output),
          usage: {
            tokens: result.usage.totalTokens,
            cost: result.usage.cost,
            duration: result.usage.duration,
          },
        };
      } catch (error) {
        updateTaskStatus(blackboard, taskId, 'failed', worker);

        return {
          success: false,
          taskId,
          worker,
          error: errorMessage(error, 'Worker failed'),
        };
      }
    },
  });

  const checkProgress = tool({
    name: 'check_progress',
    description: 'Check the progress and state of a worker agent',
    parameters: z.object({
      worker: z.string().describe('Name of the worker agent to check'),
    }),
    execute: async ({ worker }) => {
      const workerAgent = coordinator.getAgent(worker);

      if (!workerAgent) {
        return {
          found: false,
          error: `Worker agent '${worker}' not found`,
        };
      }

      const workerTasks = readTasks(blackboard).filter((t) => t.worker === worker);
      const lastTask = workerTasks[workerTasks.length - 1];
      const lastResult = lastTask ? readWorkerResults(blackboard)[lastTask.id] : undefined;

      return {
        found: true,
        worker,
        state: workerAgent.state,
        tokenCount: workerAgent.tokenCount,
        tasks: {
          total: workerTasks.length,
          completed: workerTasks.filter((t) => t.status === 'completed').length,
          pending: workerTasks.filter((t) => t.status === 'delegated').length,
          failed: workerTasks.filter((t) => t.status === 'failed').length,
          revised: workerTasks.filter((t) => t.status === 'revised').length,
        },
        lastTask: lastTask
          ? {
              id: lastTask.id,
              task: lastTask.task.slice(0, 200),
              status: lastTask.status,
              result:
                typeof lastResult === 'string'
                  ? visibleOutput(lastResult.slice(0, 500))
                  : lastResult,
            }
          : null,
      };
    },
  });

  const requestRevision = tool({
    name: 'request_revision',
    description: 'Ask a worker to revise their previous work',
    parameters: z.object({
      worker: z.string().describe('Name of the worker agent'),
      feedback: z.string().describe('Feedback on what needs to be revised'),
      taskId: z
        .string()
        .optional()
        .describe('Specific task ID to revise (uses last task if omitted)'),
    }),
    execute: async ({ worker, feedback, taskId }) => {
      const workerAgent = coordinator.getAgent(worker);

      if (!workerAgent) {
        return {
          success: false,
          error: `Worker agent '${worker}' not found`,
        };
      }

      if (worker === currentAgent) {
        return { success: false, error: 'You cannot request a revision from yourself' };
      }

      const workerTasks = readTasks(blackboard).filter((t) => t.worker === worker);
      const targetTask = taskId
        ? workerTasks.find((t) => t.id === taskId)
        : workerTasks[workerTasks.length - 1];

      if (!targetTask) {
        return {
          success: false,
          error: taskId ? `Task '${taskId}' not found` : 'No previous task found for this worker',
        };
      }

      const previousResult = readWorkerResults(blackboard)[targetTask.id];

      const revisionInput = `
REVISION REQUEST

Your previous work on this task needs revision.

Original task:
${targetTask.task}

Your previous output:
${typeof previousResult === 'string' ? previousResult : JSON.stringify(previousResult ?? null)}

Feedback:
${feedback}

Please provide a revised response addressing the feedback.
`.trim();

      try {
        const result = await coordinator.runAgent(worker, revisionInput, {
          delegationContext: {
            delegatedBy: currentAgent,
            taskId: targetTask.id,
            isRevision: true,
            originalTask: targetTask.task,
          },
        });

        recordWorkerResult(blackboard, targetTask.id, result.output, worker);
        updateTaskStatus(blackboard, targetTask.id, 'revised', worker);

        return {
          success: true,
          taskId: targetTask.id,
          worker,
          revisedOutput: visibleOutput(result.output),
        };
      } catch (error) {
        updateTaskStatus(blackboard, targetTask.id, 'failed', worker);

        return {
          success: false,
          taskId: targetTask.id,
          worker,
          error: errorMessage(error, 'Revision failed'),
        };
      }
    },
  });

  const listWorkers = tool({
    name: 'list_workers',
    description: 'List all available worker agents and their status',
    parameters: z.object({
      includeMetadata: z.boolean().optional().describe('Include worker metadata like expertise'),
    }),
    execute: async ({ includeMetadata }) => {
      const workers = coordinator.getAgentsByRole('worker');

      return {
        count: workers.length,
        workers: workers.map((w) => ({
          name: w.agent.name,
          state: w.state,
          tokenCount: w.tokenCount,
          ...(includeMetadata
            ? {
                expertise: w.metadata.expertise ?? [],
                priority: w.metadata.priority ?? 0,
              }
            : {}),
        })),
      };
    },
  });

  return {
    delegateTask,
    checkProgress,
    requestRevision,
    listWorkers,
  };
}

export type DelegationTools = ReturnType<typeof createDelegationTools>;
