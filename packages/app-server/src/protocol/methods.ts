import { z } from 'zod';
import {
  ImageDataInputSchema,
  ImageUrlInputSchema,
  MetaSchema,
  PermissionModeSchema,
  QueuedMessageSchema,
  TextInputSchema,
  UserInputSchema,
  DeliverySchema,
} from './common.js';
import {
  PendingApprovalSchema,
  PendingInterruptSchema,
  RunUsageSchema,
  StreamEventSchema,
} from '@cogitator-ai/server-shared';
import {
  MemorySearchHitSchema,
  MemorySearchParamsSchema,
  MemorySearchResultSchema,
  RunnableEventNotificationSchema,
  RunnableListParamsSchema,
  RunnableListResultSchema,
  RunnableRunParamsSchema,
  RunnableRunResultSchema,
  RunnableSchema,
  SpanSchema,
  ThreadRewindParamsSchema,
  ThreadRewindResultSchema,
  TraceGetParamsSchema,
  TraceGetResultSchema,
  TraceSpanNotificationSchema,
} from './extensions.js';
import {
  ReviewFindingSchema,
  ReviewLocationSchema,
  ReviewOutputSchema,
  ReviewTargetSchema,
} from './review.js';
import {
  AgentInfoSchema,
  ApprovalRequestParamsSchema,
  ApprovalRequestResultSchema,
  ApprovalToolCallSchema,
  ClientCapabilitiesSchema,
  ClientInfoSchema,
  InitializeParamsSchema,
  InitializeResultSchema,
  PermissionOptionSchema,
  ServerCapabilitiesSchema,
  ServerInfoSchema,
  ThreadArchiveNotificationSchema,
  ThreadLogEntrySchema,
  ThreadLogNotificationSchema,
  ThreadStartedNotificationSchema,
  TurnCompletedNotificationSchema,
  TurnEventNotificationSchema,
  TurnStartedNotificationSchema,
} from './session.js';
import {
  ThreadForkParamsSchema,
  ThreadForkResultSchema,
  ThreadIdParamsSchema,
  ThreadListParamsSchema,
  ThreadListResultSchema,
  ThreadMessageSchema,
  ThreadResultSchema,
  ThreadResumeParamsSchema,
  ThreadResumeResultSchema,
  ThreadSchema,
  ThreadSetPermissionModeParamsSchema,
  ThreadStartParamsSchema,
  ThreadStartResultSchema,
  ThreadStatusSchema,
} from './thread.js';
import {
  ApprovalDecisionSchema,
  ReviewStartParamsSchema,
  ReviewStartResultSchema,
  TurnErrorSchema,
  TurnInterruptParamsSchema,
  TurnInterruptResultSchema,
  TurnPendingSchema,
  TurnResumeSchema,
  TurnSchema,
  TurnStartParamsSchema,
  TurnStartResultSchema,
  TurnStatusSchema,
  TurnSteerParamsSchema,
  TurnSteerResultSchema,
  TurnUsageSchema,
} from './turn.js';

/** A request of the protocol: the schema of its params and of its result */
export interface MethodSchemas<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  params: P;
  result: R;
  /** The name of the method on the generated client */
  clientName: string;
  /** What the method does, for the generated client */
  description: string;
}

function method<P extends z.ZodType, R extends z.ZodType>(
  params: P,
  result: R,
  clientName: string,
  description: string
): MethodSchemas<P, R> {
  return { params, result, clientName, description };
}

/** The requests a client sends to the app-server */
export const APP_SERVER_METHODS = {
  initialize: method(
    InitializeParamsSchema,
    InitializeResultSchema,
    'initialize',
    'Opens the session: what the client can do, answered by what the server can do and its agents'
  ),
  'thread/start': method(
    ThreadStartParamsSchema,
    ThreadStartResultSchema,
    'threadStart',
    'Starts a thread with an agent, then sends `thread/started`'
  ),
  'thread/resume': method(
    ThreadResumeParamsSchema,
    ThreadResumeResultSchema,
    'threadResume',
    'Opens a thread kept in memory, with the messages of its active branch'
  ),
  'thread/fork': method(
    ThreadForkParamsSchema,
    ThreadForkResultSchema,
    'threadFork',
    'Forks a thread into a new one holding its branch up to an entry, then sends `thread/started`'
  ),
  'thread/list': method(
    ThreadListParamsSchema,
    ThreadListResultSchema,
    'threadList',
    'Lists the threads a page at a time, newest first'
  ),
  'thread/archive': method(
    ThreadIdParamsSchema,
    ThreadResultSchema,
    'threadArchive',
    'Archives a thread, then sends `thread/archived`'
  ),
  'thread/unarchive': method(
    ThreadIdParamsSchema,
    ThreadResultSchema,
    'threadUnarchive',
    'Takes a thread out of the archive, then sends `thread/unarchived`'
  ),
  'thread/setPermissionMode': method(
    ThreadSetPermissionModeParamsSchema,
    ThreadResultSchema,
    'threadSetPermissionMode',
    'Sets the permission mode of a thread, for the turn going on from its next tool call'
  ),
  'turn/start': method(
    TurnStartParamsSchema,
    TurnStartResultSchema,
    'turnStart',
    'Starts a turn: the answer comes first, then `turn/started`, `turn/event` and `turn/completed`'
  ),
  'turn/steer': method(
    TurnSteerParamsSchema,
    TurnSteerResultSchema,
    'turnSteer',
    'Sends a message to the turn going on'
  ),
  'turn/interrupt': method(
    TurnInterruptParamsSchema,
    TurnInterruptResultSchema,
    'turnInterrupt',
    'Stops the turn going on, which then completes as `interrupted`'
  ),
  'review/start': method(
    ReviewStartParamsSchema,
    ReviewStartResultSchema,
    'reviewStart',
    'Reviews changes in a review thread of their own, the completed turn carrying `review`'
  ),
  '_cogitator/memory/search': method(
    MemorySearchParamsSchema,
    MemorySearchResultSchema,
    'memorySearch',
    'Searches the turns of a thread and the memory items of an agent'
  ),
  '_cogitator/thread/rewind': method(
    ThreadRewindParamsSchema,
    ThreadRewindResultSchema,
    'threadRewind',
    'Rewinds a thread to an entry, its memory and optionally its files with it'
  ),
  '_cogitator/trace/get': method(
    TraceGetParamsSchema,
    TraceGetResultSchema,
    'traceGet',
    'The spans the host keeps of a turn'
  ),
  '_cogitator/workflow/list': method(
    RunnableListParamsSchema,
    RunnableListResultSchema,
    'workflowList',
    'Lists the workflows the host runs'
  ),
  '_cogitator/workflow/run': method(
    RunnableRunParamsSchema,
    RunnableRunResultSchema,
    'workflowRun',
    'Runs a workflow, sending `_cogitator/workflow/event` while it goes on'
  ),
  '_cogitator/swarm/list': method(
    RunnableListParamsSchema,
    RunnableListResultSchema,
    'swarmList',
    'Lists the swarms the host runs'
  ),
  '_cogitator/swarm/run': method(
    RunnableRunParamsSchema,
    RunnableRunResultSchema,
    'swarmRun',
    'Runs a swarm, sending `_cogitator/swarm/event` while it goes on'
  ),
} as const;

/** The notifications the app-server sends */
export const APP_SERVER_NOTIFICATIONS = {
  'thread/started': ThreadStartedNotificationSchema,
  'thread/archived': ThreadArchiveNotificationSchema,
  'thread/unarchived': ThreadArchiveNotificationSchema,
  'thread/log': ThreadLogNotificationSchema,
  'turn/started': TurnStartedNotificationSchema,
  'turn/event': TurnEventNotificationSchema,
  'turn/completed': TurnCompletedNotificationSchema,
  '_cogitator/workflow/event': RunnableEventNotificationSchema,
  '_cogitator/swarm/event': RunnableEventNotificationSchema,
  '_cogitator/trace/span': TraceSpanNotificationSchema,
} as const;

/** The requests the app-server sends to the client */
export const APP_SERVER_SERVER_REQUESTS = {
  'approval/request': method(
    ApprovalRequestParamsSchema,
    ApprovalRequestResultSchema,
    'approvalRequest',
    'Asks the client to decide a tool call while the turn waits'
  ),
} as const;

export type AppServerMethod = keyof typeof APP_SERVER_METHODS;
export type AppServerNotificationMethod = keyof typeof APP_SERVER_NOTIFICATIONS;
export type AppServerServerRequestMethod = keyof typeof APP_SERVER_SERVER_REQUESTS;

export type AppServerParams<M extends AppServerMethod> = z.input<
  (typeof APP_SERVER_METHODS)[M]['params']
>;
export type AppServerResult<M extends AppServerMethod> = z.output<
  (typeof APP_SERVER_METHODS)[M]['result']
>;
/**
 * Every named schema of the protocol with the name it is generated under, in the order the
 * generated client prints them
 */
export const APP_SERVER_SCHEMAS: ReadonlyArray<readonly [name: string, schema: z.ZodType]> = [
  ['Meta', MetaSchema],
  ['PermissionMode', PermissionModeSchema],
  ['TextInput', TextInputSchema],
  ['ImageUrlInput', ImageUrlInputSchema],
  ['ImageDataInput', ImageDataInputSchema],
  ['UserInput', UserInputSchema],
  ['Delivery', DeliverySchema],
  ['QueuedMessage', QueuedMessageSchema],
  ['RunUsage', RunUsageSchema],
  ['PendingApproval', PendingApprovalSchema],
  ['PendingInterrupt', PendingInterruptSchema],
  ['StreamEvent', StreamEventSchema],
  ['ClientInfo', ClientInfoSchema],
  ['ServerInfo', ServerInfoSchema],
  ['ClientCapabilities', ClientCapabilitiesSchema],
  ['ServerCapabilities', ServerCapabilitiesSchema],
  ['AgentInfo', AgentInfoSchema],
  ['InitializeParams', InitializeParamsSchema],
  ['InitializeResult', InitializeResultSchema],
  ['ThreadStatus', ThreadStatusSchema],
  ['Thread', ThreadSchema],
  ['ThreadMessage', ThreadMessageSchema],
  ['ThreadStartParams', ThreadStartParamsSchema],
  ['ThreadStartResult', ThreadStartResultSchema],
  ['ThreadResumeParams', ThreadResumeParamsSchema],
  ['ThreadResumeResult', ThreadResumeResultSchema],
  ['ThreadForkParams', ThreadForkParamsSchema],
  ['ThreadForkResult', ThreadForkResultSchema],
  ['ThreadListParams', ThreadListParamsSchema],
  ['ThreadListResult', ThreadListResultSchema],
  ['ThreadIdParams', ThreadIdParamsSchema],
  ['ThreadResult', ThreadResultSchema],
  ['ThreadSetPermissionModeParams', ThreadSetPermissionModeParamsSchema],
  ['ApprovalDecision', ApprovalDecisionSchema],
  ['TurnResume', TurnResumeSchema],
  ['TurnStatus', TurnStatusSchema],
  ['TurnUsage', TurnUsageSchema],
  ['TurnError', TurnErrorSchema],
  ['TurnPending', TurnPendingSchema],
  ['ReviewTarget', ReviewTargetSchema],
  ['ReviewLocation', ReviewLocationSchema],
  ['ReviewFinding', ReviewFindingSchema],
  ['ReviewOutput', ReviewOutputSchema],
  ['Turn', TurnSchema],
  ['TurnStartParams', TurnStartParamsSchema],
  ['TurnStartResult', TurnStartResultSchema],
  ['TurnSteerParams', TurnSteerParamsSchema],
  ['TurnSteerResult', TurnSteerResultSchema],
  ['TurnInterruptParams', TurnInterruptParamsSchema],
  ['TurnInterruptResult', TurnInterruptResultSchema],
  ['ReviewStartParams', ReviewStartParamsSchema],
  ['ReviewStartResult', ReviewStartResultSchema],
  ['MemorySearchParams', MemorySearchParamsSchema],
  ['MemorySearchHit', MemorySearchHitSchema],
  ['MemorySearchResult', MemorySearchResultSchema],
  ['ThreadRewindParams', ThreadRewindParamsSchema],
  ['ThreadRewindResult', ThreadRewindResultSchema],
  ['Span', SpanSchema],
  ['TraceGetParams', TraceGetParamsSchema],
  ['TraceGetResult', TraceGetResultSchema],
  ['TraceSpanNotification', TraceSpanNotificationSchema],
  ['Runnable', RunnableSchema],
  ['RunnableListParams', RunnableListParamsSchema],
  ['RunnableListResult', RunnableListResultSchema],
  ['RunnableRunParams', RunnableRunParamsSchema],
  ['RunnableRunResult', RunnableRunResultSchema],
  ['RunnableEventNotification', RunnableEventNotificationSchema],
  ['PermissionOption', PermissionOptionSchema],
  ['ApprovalToolCall', ApprovalToolCallSchema],
  ['ApprovalRequestParams', ApprovalRequestParamsSchema],
  ['ApprovalRequestResult', ApprovalRequestResultSchema],
  ['ThreadStartedNotification', ThreadStartedNotificationSchema],
  ['ThreadArchiveNotification', ThreadArchiveNotificationSchema],
  ['ThreadLogEntry', ThreadLogEntrySchema],
  ['ThreadLogNotification', ThreadLogNotificationSchema],
  ['TurnStartedNotification', TurnStartedNotificationSchema],
  ['TurnEventNotification', TurnEventNotificationSchema],
  ['TurnCompletedNotification', TurnCompletedNotificationSchema],
];
