import type { z } from 'zod';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import type {
  DeliverySchema,
  PermissionModeSchema,
  QueuedMessageSchema,
  UserInputSchema,
} from './common.js';
import type {
  MemorySearchParamsSchema,
  MemorySearchResultSchema,
  RunnableSchema,
  ThreadRewindParamsSchema,
  ThreadRewindResultSchema,
} from './extensions.js';
import type { ReviewFindingSchema, ReviewOutputSchema, ReviewTargetSchema } from './review.js';
import type {
  AgentInfoSchema,
  ApprovalRequestParamsSchema,
  ApprovalRequestResultSchema,
  ClientCapabilitiesSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  ServerCapabilitiesSchema,
  ThreadLogNotificationSchema,
  TurnEventNotificationSchema,
} from './session.js';
import type {
  RunnableEventNotificationSchema,
  SpanSchema,
  TraceGetResultSchema,
  TraceSpanNotificationSchema,
} from './extensions.js';
import type {
  ThreadForkParamsSchema,
  ThreadListParamsSchema,
  ThreadListResultSchema,
  ThreadMessageSchema,
  ThreadResumeResultSchema,
  ThreadSchema,
  ThreadStartParamsSchema,
  ThreadStatusSchema,
} from './thread.js';
import type {
  ApprovalDecisionSchema,
  ReviewStartParamsSchema,
  TurnErrorSchema,
  TurnPendingSchema,
  TurnResumeSchema,
  TurnSchema,
  TurnStartParamsSchema,
  TurnStatusSchema,
  TurnSteerParamsSchema,
  TurnUsageSchema,
} from './turn.js';

export type UserInput = z.output<typeof UserInputSchema>;
export type Delivery = z.output<typeof DeliverySchema>;
export type QueuedMessage = z.output<typeof QueuedMessageSchema>;
export type ProtocolPermissionMode = z.output<typeof PermissionModeSchema>;
export type ClientCapabilities = z.output<typeof ClientCapabilitiesSchema>;
export type ServerCapabilities = z.output<typeof ServerCapabilitiesSchema>;
export type AgentInfo = z.output<typeof AgentInfoSchema>;
export type InitializeParams = z.output<typeof InitializeParamsSchema>;
export type InitializeResult = z.output<typeof InitializeResultSchema>;
export type ThreadStatus = z.output<typeof ThreadStatusSchema>;
export type ThreadInfo = z.output<typeof ThreadSchema>;
export type ThreadMessage = z.output<typeof ThreadMessageSchema>;
export type ThreadStartParams = z.output<typeof ThreadStartParamsSchema>;
export type ThreadResumeResult = z.output<typeof ThreadResumeResultSchema>;
export type ThreadForkParams = z.output<typeof ThreadForkParamsSchema>;
export type ThreadListParams = z.output<typeof ThreadListParamsSchema>;
export type ThreadListResult = z.output<typeof ThreadListResultSchema>;
export type ApprovalDecision = z.output<typeof ApprovalDecisionSchema>;
export type TurnResume = z.output<typeof TurnResumeSchema>;
export type TurnStatus = z.output<typeof TurnStatusSchema>;
export type TurnUsage = z.output<typeof TurnUsageSchema>;
export type TurnError = z.output<typeof TurnErrorSchema>;
export type TurnPending = z.output<typeof TurnPendingSchema>;
export type TurnInfo = z.output<typeof TurnSchema>;
export type TurnStartParams = z.output<typeof TurnStartParamsSchema>;
export type TurnSteerParams = z.output<typeof TurnSteerParamsSchema>;
export type ReviewTarget = z.output<typeof ReviewTargetSchema>;
export type ReviewFinding = z.output<typeof ReviewFindingSchema>;
export type ReviewOutput = z.output<typeof ReviewOutputSchema>;
export type ReviewStartParams = z.output<typeof ReviewStartParamsSchema>;
export type MemorySearchParams = z.output<typeof MemorySearchParamsSchema>;
export type MemorySearchResult = z.output<typeof MemorySearchResultSchema>;
export type ThreadRewindParams = z.output<typeof ThreadRewindParamsSchema>;
export type ThreadRewindResult = z.output<typeof ThreadRewindResultSchema>;
export type Runnable = z.output<typeof RunnableSchema>;
export type ApprovalRequestParams = z.output<typeof ApprovalRequestParamsSchema>;
export type ApprovalRequestResult = z.output<typeof ApprovalRequestResultSchema>;
/** A `turn/event`, its event typed as the stream protocol's `StreamEvent` */
export type TurnEventNotification = Omit<z.output<typeof TurnEventNotificationSchema>, 'event'> & {
  event: StreamEvent;
};
export type ThreadLogNotification = z.output<typeof ThreadLogNotificationSchema>;
export type RunnableEventNotification = z.output<typeof RunnableEventNotificationSchema>;
export type TraceSpan = z.output<typeof SpanSchema>;
export type TraceGetResult = z.output<typeof TraceGetResultSchema>;
export type TraceSpanNotification = z.output<typeof TraceSpanNotificationSchema>;

/** A notification of the app-server, told apart by `method` */
export type AppServerNotification =
  | { method: 'thread/started'; params: { thread: ThreadInfo } }
  | { method: 'thread/archived'; params: { threadId: string } }
  | { method: 'thread/unarchived'; params: { threadId: string } }
  | { method: 'thread/log'; params: ThreadLogNotification }
  | { method: 'turn/started'; params: { threadId: string; turn: TurnInfo } }
  | { method: 'turn/event'; params: TurnEventNotification }
  | { method: 'turn/completed'; params: { threadId: string; turn: TurnInfo } }
  | { method: '_cogitator/workflow/event'; params: RunnableEventNotification }
  | { method: '_cogitator/swarm/event'; params: RunnableEventNotification }
  | { method: '_cogitator/trace/span'; params: TraceSpanNotification };
