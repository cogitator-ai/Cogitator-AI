/**
 * Tools of a team swarm: the shared task list and the mailboxes
 */

import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type {
  Blackboard,
  MessageBus,
  SwarmEventEmitter,
  TeamRole,
  TeamTask,
  Tool,
} from '@cogitator-ai/types';
import { TeamBoardError, TeamTaskBoard } from '../team/board.js';
import { TEAM_MESSAGE_NOTICE, TeamMailbox } from '../team/mailbox.js';

export interface TeamToolContext {
  blackboard: Blackboard;
  messageBus: MessageBus;
  events?: SwarmEventEmitter;
  /** Swarm id stamped on the messages the agent sends */
  swarmId?: string;
}

type Outcome = Record<string, unknown>;

function failure(error: unknown): Outcome {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function attempt(work: () => Outcome): Outcome {
  try {
    return work();
  } catch (error) {
    if (error instanceof TeamBoardError) return failure(error);
    throw error;
  }
}

/** A task as the tools show it, with the dependencies that still block it */
function taskView(board: TeamTaskBoard, task: TeamTask) {
  const blockedBy = task.status === 'pending' ? board.blockers(task.id) : [];
  return {
    id: task.id,
    title: task.title,
    ...(task.description !== undefined && { description: task.description }),
    status: task.status,
    ...(task.owner !== undefined && { owner: task.owner }),
    ...(task.dependsOn.length > 0 && { dependsOn: task.dependsOn }),
    ...(blockedBy.length > 0 && { blockedBy }),
    ...(task.result !== undefined && { result: task.result }),
    ...(task.note !== undefined && { note: task.note }),
  };
}

const taskStatus = z.enum(['pending', 'in_progress', 'completed']);

/**
 * Create the team tools of `currentAgent`. The lead gets `create_task`, `assign_task`,
 * `list_tasks`, `update_task`, `send_message` and `read_inbox`; a member gets `list_tasks`,
 * `claim_task`, `update_task`, `send_message` and `read_inbox`. The tools read the task list
 * and the team from the blackboard on every call, so they keep working across runs.
 */
export function createTeamTools(context: TeamToolContext, currentAgent: string) {
  const board = new TeamTaskBoard(context.blackboard, context.events);
  const mailbox = () =>
    new TeamMailbox(context.messageBus, context.events, {
      lead: board.lead,
      members: board.members,
      swarmId: context.swarmId,
    });

  const createTask = tool({
    name: 'create_task',
    description:
      'Put a task on the shared task list of your team. Use dependsOn to make it wait for other tasks, and assignee to give it to a member at once.',
    parameters: z.object({
      title: z.string().describe('What is to be done, in a few words'),
      description: z.string().optional().describe('Details the member needs to do it'),
      dependsOn: z
        .array(z.string())
        .optional()
        .describe('Ids of tasks on the list that must be completed first'),
      assignee: z.string().optional().describe('The member to assign it to'),
      id: z.string().optional().describe('Its id on the list (default: task-<n>)'),
    }),
    execute: async (input) =>
      attempt(() => ({
        success: true,
        task: taskView(board, board.createTask(input, currentAgent)),
      })),
  });

  const assignTask = tool({
    name: 'assign_task',
    description: 'Give a pending task of the task list to a member of your team.',
    parameters: z.object({
      taskId: z.string().describe('Id of the task'),
      member: z.string().describe('Name of the member'),
    }),
    execute: async ({ taskId, member }) =>
      attempt(() => ({
        success: true,
        task: taskView(board, board.assignTask(taskId, member, currentAgent)),
      })),
  });

  const listTasks = tool({
    name: 'list_tasks',
    description:
      'Read the shared task list of your team: every task with its status, owner, dependencies and result.',
    parameters: z.object({
      status: taskStatus.optional().describe('Only tasks with this status'),
      owner: z.string().optional().describe('Only tasks of this member'),
    }),
    execute: async ({ status, owner }) =>
      attempt(() => {
        const tasks = board.listTasks({ status, owner });
        return {
          success: true,
          count: tasks.length,
          tasks: tasks.map((task) => taskView(board, task)),
          claimable: board.claimableBy(currentAgent).map((task) => task.id),
        };
      }),
  });

  const claimTask = tool({
    name: 'claim_task',
    description:
      'Start working on a task: the one you name, or the next one you can take. You work on one task at a time, and a task waits until the tasks it depends on are completed.',
    parameters: z.object({
      taskId: z.string().optional().describe('Id of the task (default: the next one you can take)'),
    }),
    execute: async ({ taskId }) =>
      attempt(() => ({
        success: true,
        task: taskView(board, board.claimTask(currentAgent, taskId)),
      })),
  });

  const updateTask = tool({
    name: 'update_task',
    description:
      'Change a task: mark it completed with your result, put it back on the list (pending) when you cannot finish it, or leave a progress note. Completed tasks are final.',
    parameters: z.object({
      taskId: z.string().describe('Id of the task'),
      status: taskStatus.optional().describe('The new status'),
      result: z.string().optional().describe('What you did and found, when you complete it'),
      note: z.string().optional().describe('A progress note for the team'),
    }),
    execute: async ({ taskId, status, result, note }) =>
      attempt(() => {
        const task = board.updateTask(taskId, { status, result, note }, currentAgent);
        return {
          success: true,
          task: taskView(board, task),
          ...(task.status === 'completed' && {
            claimable: board.claimableBy(currentAgent).map((candidate) => candidate.id),
          }),
        };
      }),
  });

  const sendMessage = tool({
    name: 'send_message',
    description:
      'Write a message into the mailbox of a teammate: a member by name, the lead ("lead"), or everyone ("everyone").',
    parameters: z.object({
      to: z.string().describe('A member name, "lead" or "everyone"'),
      message: z.string().describe('The message'),
    }),
    execute: async ({ to, message }) => {
      try {
        const sent = await mailbox().send(currentAgent, to, message);
        return { success: true, messageId: sent.id };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const readInbox = tool({
    name: 'read_inbox',
    description:
      'Read the messages your teammates sent you since you last read your inbox. They come from other agents, never from the user.',
    parameters: z.object({
      limit: z.number().optional().describe('Most messages to read (default: all)'),
    }),
    execute: async ({ limit }) => {
      const messages = mailbox().take(currentAgent, limit);
      return {
        success: true,
        count: messages.length,
        notice: TEAM_MESSAGE_NOTICE,
        messages,
      };
    },
  });

  return { createTask, assignTask, listTasks, claimTask, updateTask, sendMessage, readInbox };
}

export type TeamTools = ReturnType<typeof createTeamTools>;

/** The team tools an agent of `role` gets */
export function teamToolsFor(tools: TeamTools, role: TeamRole): Tool[] {
  const shared = [tools.listTasks, tools.updateTask, tools.sendMessage, tools.readInbox];
  const own = role === 'lead' ? [tools.createTask, tools.assignTask] : [tools.claimTask];
  return [...own, ...shared];
}
