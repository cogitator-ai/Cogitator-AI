import { z } from 'zod';
import { PendingApprovalSchema, StreamEventSchema } from '@cogitator-ai/server-shared';
import { protocolObject } from './common.js';
import { ThreadSchema } from './thread.js';
import { TurnSchema } from './turn.js';

export const ClientInfoSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  version: z.string().optional(),
});

export const ServerInfoSchema = z.object({ name: z.string(), version: z.string() });

export const ClientCapabilitiesSchema = protocolObject({
  approvals: z
    .enum(['request', 'pause'])
    .optional()
    .describe(
      '`request` to be asked with `approval/request` while a turn waits, `pause` (the default) to have the turn end paused'
    ),
  traces: z
    .boolean()
    .optional()
    .describe('Whether to send `_cogitator/trace/span` as the spans of turns end'),
  optOutNotifications: z
    .array(z.string())
    .optional()
    .describe('Notification methods not to send, such as `thread/log`'),
});

export const ServerCapabilitiesSchema = protocolObject({
  approvals: z.array(z.enum(['request', 'pause'])),
  review: z.boolean(),
  memorySearch: z.boolean(),
  rewind: z.boolean(),
  workflows: z.boolean(),
  swarms: z.boolean(),
  threadLog: z.boolean().describe('Whether `thread/log` notifications are sent'),
  traces: z.boolean().describe('Whether the spans of turns are kept and sent'),
});

export const AgentInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  default: z.boolean(),
});

export const InitializeParamsSchema = protocolObject({
  protocolVersion: z.number().int().describe('The protocol version the client speaks'),
  clientInfo: ClientInfoSchema,
  capabilities: ClientCapabilitiesSchema.optional(),
});

export const InitializeResultSchema = protocolObject({
  protocolVersion: z.number().int().describe('The protocol version the server speaks'),
  serverInfo: ServerInfoSchema,
  capabilities: ServerCapabilitiesSchema,
  agents: z.array(AgentInfoSchema),
});

export const PermissionOptionSchema = z
  .object({
    optionId: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
    name: z.string(),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  })
  .describe('A choice for an approval, as ACP `session/request_permission` offers it');

export const ApprovalToolCallSchema = PendingApprovalSchema.extend({
  subagent: z
    .string()
    .optional()
    .describe('The subagent the call is made in, when its approval bubbled up'),
});

export const ApprovalRequestParamsSchema = protocolObject({
  threadId: z.string(),
  turnId: z.string(),
  toolCall: ApprovalToolCallSchema,
  options: z.array(PermissionOptionSchema),
}).describe(
  'Asks the client to decide a tool call, in the form of ACP `session/request_permission`'
);

export const ApprovalRequestResultSchema = protocolObject({
  outcome: z.union([
    z.object({ outcome: z.literal('selected'), optionId: PermissionOptionSchema.shape.optionId }),
    z.object({ outcome: z.literal('cancelled') }),
  ]),
  updatedArguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arguments to run an allowed call with instead'),
  reason: z.string().optional().describe('Why the call was rejected, for the model'),
}).describe('`cancelled` leaves the call waiting: the turn ends paused');

export const ThreadStartedNotificationSchema = protocolObject({ thread: ThreadSchema });

export const ThreadArchiveNotificationSchema = protocolObject({ threadId: z.string() });

export const TurnStartedNotificationSchema = protocolObject({
  threadId: z.string(),
  turn: TurnSchema,
});

export const TurnEventNotificationSchema = protocolObject({
  threadId: z.string(),
  turnId: z.string(),
  event: StreamEventSchema,
  parentToolCallId: z
    .string()
    .optional()
    .describe('The tool call of the run that delegated the run the event is of, for a subagent'),
  agent: z.string().optional().describe('The agent of that delegated run'),
}).describe('An event of the stream protocol of a turn, or of a run it delegated');

export const TurnCompletedNotificationSchema = protocolObject({
  threadId: z.string(),
  turn: TurnSchema,
});

export const ThreadLogEntrySchema = z.object({
  id: z.string(),
  type: z.string().describe('message, tool_result, or a session event such as compaction'),
  role: z.enum(['system', 'user', 'assistant', 'tool']).optional(),
  text: z.string().optional(),
  parentId: z.string().nullable().optional(),
  createdAt: z.string(),
});

export const ThreadLogNotificationSchema = protocolObject({
  threadId: z.string(),
  change: z.enum([
    'entry-added',
    'entry-deleted',
    'entry-redacted',
    'thread-cleared',
    'thread-deleted',
  ]),
  entryId: z.string().optional(),
  entry: ThreadLogEntrySchema.optional(),
}).describe('A change to the memory of a thread, as the adapter reports it');
