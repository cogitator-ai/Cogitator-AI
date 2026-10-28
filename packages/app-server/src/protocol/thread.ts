import { z } from 'zod';
import { PermissionModeSchema, protocolObject } from './common.js';
import { TurnPendingSchema } from './turn.js';

export const ThreadStatusSchema = z
  .enum(['idle', 'running', 'paused'])
  .describe('`running` while a turn goes on, `paused` while a turn waits on approvals or answers');

export const ThreadSchema = protocolObject({
  id: z.string(),
  agent: z
    .string()
    .optional()
    .describe('The agent the thread runs, by the name `initialize` lists it under'),
  status: ThreadStatusSchema,
  archived: z.boolean(),
  activeTurnId: z.string().optional().describe('The turn going on, while `running`'),
  forkedFrom: z.string().optional().describe('The thread this one was forked from'),
  permissionMode: PermissionModeSchema.optional().describe(
    'The permission mode new turns of the thread start in'
  ),
  createdAt: z.string().describe('ISO time'),
  updatedAt: z.string().describe('ISO time the thread itself last changed'),
  metadata: z.record(z.string(), z.unknown()),
}).describe('A conversation with an agent, kept in the memory of the runtime');

export const ThreadMessageSchema = protocolObject({
  entryId: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  text: z.string(),
  createdAt: z.string(),
}).describe('A message of the active branch of a thread');

export const ThreadStartParamsSchema = protocolObject({
  agent: z.string().optional().describe('The agent to run, the default agent when left out'),
  threadId: z.string().min(1).optional().describe('An id of your own for the thread'),
  metadata: z.record(z.string(), z.unknown()).optional(),
  permissionMode: PermissionModeSchema.optional(),
});

export const ThreadStartResultSchema = protocolObject({ thread: ThreadSchema });

export const ThreadResumeParamsSchema = protocolObject({ threadId: z.string() });

export const ThreadResumeResultSchema = protocolObject({
  thread: ThreadSchema,
  messages: z.array(ThreadMessageSchema),
  pending: TurnPendingSchema.optional().describe('What the paused thread waits on'),
});

export const ThreadForkParamsSchema = protocolObject({
  threadId: z.string(),
  atEntryId: z
    .string()
    .optional()
    .describe('The last entry the fork keeps, the end of the active branch by default'),
  newThreadId: z.string().min(1).optional(),
});

export const ThreadForkResultSchema = protocolObject({ thread: ThreadSchema });

export const ThreadListParamsSchema = protocolObject({
  archived: z
    .boolean()
    .optional()
    .describe('`true` for archived threads only, `false` for the others, unset for all'),
  agent: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const ThreadListResultSchema = protocolObject({
  threads: z.array(ThreadSchema),
  nextCursor: z.string().optional(),
});

export const ThreadIdParamsSchema = protocolObject({ threadId: z.string() });

export const ThreadResultSchema = protocolObject({ thread: ThreadSchema });

export const ThreadSetPermissionModeParamsSchema = protocolObject({
  threadId: z.string(),
  mode: PermissionModeSchema,
});
