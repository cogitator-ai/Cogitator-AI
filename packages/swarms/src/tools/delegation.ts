/**
 * Swarm delegation tools for hierarchical task management
 */

import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { SwarmCoordinatorInterface, Blackboard } from '@cogitator-ai/types';

/**
 * Create delegation tools for supervisor agents
 */
export function createDelegationTools(
  coordinator: SwarmCoordinatorInterface,
  blackboard: Blackboard,
  currentAgent: string
) {
  const delegateTask = tool({
    name: 'delegate_task',
    description: 'Delegate a task to a worker agent',
    parameters: z.object({
      worker: z.string().describe('Name of the worker agent to delegate to'),
      task: z.string().describe('The task description to delegate'),
      context: z.record(z.unknown()).optional().describe('Additional context for the worker'),
      priority: z.enum(['high', 'normal', 'low']).optional().describe('Task priority'),
      waitForCompletion: z.boolean().optional().describe('Wait for worker to complete (default: true)'),
    }),
    execute: async ({ worker, task, context, priority = 'normal', waitForCompletion = true }) => {
      const workerAgent = coordinator.getAgent(worker);

      if (!workerAgent) {
        return {
          success: false,
          error: `Worker agent '${worker}' not found`,
          availableWorkers: coordinator.getAgentsByRole('worker').map(a => a.agent.name),
        };
      }

      const tasks = blackboard.read<{
        id: string;
        worker: string;
        task: string;
        status: string;
        delegatedBy: string;
        timestamp: number;
      }[]>('tasks') ?? [];

      const taskId = `task_${Date.now()}_${worker}`;
      tasks.push({
        id: taskId,
        worker,
        task,
        status: 'delegated',
        delegatedBy: currentAgent,
        timestamp: Date.now(),
      });
      blackboard.write('tasks', tasks, currentAgent);

      if (!waitForCompletion) {
        coordinator.runAgent(worker, task, {
          ...context,
          delegationContext: {
            delegatedBy: currentAgent,
            taskId,
            priority,
          },
        }).then(result => {
          const currentTasks = blackboard.read<typeof tasks>('tasks') ?? [];
          const taskIndex = currentTasks.findIndex(t => t.id === taskId);
          if (taskIndex >= 0) {
            currentTasks[taskIndex].status = 'completed';
          }
          blackboard.write('tasks', currentTasks, worker);

          const workerResults = blackboard.read<Record<string, unknown>>('workerResults') ?? {};
          workerResults[taskId] = result.output;
          blackboard.write('workerResults', workerResults, worker);
        }).catch(() => {
          const currentTasks = blackboard.read<typeof tasks>('tasks') ?? [];
          const taskIndex = currentTasks.findIndex(t => t.id === taskId);
          if (taskIndex >= 0) {
            currentTasks[taskIndex].status = 'failed';
          }
          blackboard.write('tasks', currentTasks, worker);
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
        const result = await coordinator.runAgent(worker, task, {
          ...context,
          delegationContext: {
            delegatedBy: currentAgent,
            taskId,
            priority,
          },
        });

        const currentTasks = blackboard.read<typeof tasks>('tasks') ?? [];
        const taskIndex = currentTasks.findIndex(t => t.id === taskId);
        if (taskIndex >= 0) {
          currentTasks[taskIndex].status = 'completed';
        }
        blackboard.write('tasks', currentTasks, worker);

        const workerResults = blackboard.read<Record<string, unknown>>('workerResults') ?? {};
        workerResults[taskId] = result.output;
        blackboard.write('workerResults', workerResults, worker);

        return {
          success: true,
          taskId,
          worker,
          output: result.output,
          usage: {
            tokens: result.usage.totalTokens,
            cost: result.usage.cost,
            duration: result.usage.duration,
          },
        };
      } catch (error) {
        const currentTasks = blackboard.read<typeof tasks>('tasks') ?? [];
        const taskIndex = currentTasks.findIndex(t => t.id === taskId);
        if (taskIndex >= 0) {
          currentTasks[taskIndex].status = 'failed';
        }
        blackboard.write('tasks', currentTasks, worker);

        return {
          success: false,
          taskId,
          worker,
          error: error instanceof Error ? error.message : 'Worker failed',
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

      const tasks = blackboard.read<{
        id: string;
        worker: string;
        task: string;
        status: string;
        timestamp: number;
      }[]>('tasks') ?? [];

      const workerTasks = tasks.filter(t => t.worker === worker);
      const lastTask = workerTasks[workerTasks.length - 1];

      const workerResults = blackboard.read<Record<string, unknown>>('workerResults') ?? {};
      const lastResult = lastTask ? workerResults[lastTask.id] : undefined;

      return {
        found: true,
        worker,
        state: workerAgent.state,
        tokenCount: workerAgent.tokenCount,
        tasks: {
          total: workerTasks.length,
          completed: workerTasks.filter(t => t.status === 'completed').length,
          pending: workerTasks.filter(t => t.status === 'delegated').length,
          failed: workerTasks.filter(t => t.status === 'failed').length,
        },
        lastTask: lastTask ? {
          id: lastTask.id,
          task: lastTask.task.slice(0, 200),
          status: lastTask.status,
          result: typeof lastResult === 'string' ? lastResult.slice(0, 500) : lastResult,
        } : null,
      };
    },
  });

  const requestRevision = tool({
    name: 'request_revision',
    description: 'Ask a worker to revise their previous work',
    parameters: z.object({
      worker: z.string().describe('Name of the worker agent'),
      feedback: z.string().describe('Feedback on what needs to be revised'),
      taskId: z.string().optional().describe('Specific task ID to revise (uses last task if omitted)'),
    }),
    execute: async ({ worker, feedback, taskId }) => {
      const workerAgent = coordinator.getAgent(worker);

      if (!workerAgent) {
        return {
          success: false,
          error: `Worker agent '${worker}' not found`,
        };
      }

      const tasks = blackboard.read<{
        id: string;
        worker: string;
        task: string;
        status: string;
      }[]>('tasks') ?? [];

      const workerTasks = tasks.filter(t => t.worker === worker);
      const targetTask = taskId
        ? workerTasks.find(t => t.id === taskId)
        : workerTasks[workerTasks.length - 1];

      if (!targetTask) {
        return {
          success: false,
          error: taskId ? `Task '${taskId}' not found` : 'No previous task found for this worker',
        };
      }

      const workerResults = blackboard.read<Record<string, unknown>>('workerResults') ?? {};
      const previousResult = workerResults[targetTask.id];

      const revisionInput = `
REVISION REQUEST

Your previous work on this task needs revision.

Original task:
${targetTask.task}

Your previous output:
${typeof previousResult === 'string' ? previousResult : JSON.stringify(previousResult)}

Feedback:
${feedback}

Please provide a revised response addressing the feedback.
`.trim();

      const result = await coordinator.runAgent(worker, revisionInput, {
        delegationContext: {
          delegatedBy: currentAgent,
          taskId: targetTask.id,
          isRevision: true,
          originalTask: targetTask.task,
        },
      });

      workerResults[targetTask.id] = result.output;
      blackboard.write('workerResults', workerResults, worker);

      const updatedTasks = blackboard.read<typeof tasks>('tasks') ?? [];
      const taskIndex = updatedTasks.findIndex(t => t.id === targetTask.id);
      if (taskIndex >= 0) {
        updatedTasks[taskIndex].status = 'revised';
      }
      blackboard.write('tasks', updatedTasks, worker);

      return {
        success: true,
        taskId: targetTask.id,
        worker,
        revisedOutput: result.output,
      };
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
        workers: workers.map(w => ({
          name: w.agent.name,
          state: w.state,
          tokenCount: w.tokenCount,
          ...(includeMetadata ? {
            expertise: w.metadata.expertise ?? [],
            priority: w.metadata.priority ?? 0,
          } : {}),
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
