import { z } from 'zod';

/**
 * The error codes of the app-server: those JSON-RPC 2.0 defines, `-32002` as ACP has it for
 * something that does not exist, and the app-server's own from `-32010` on
 */
export const APP_SERVER_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  /** Params that do not match the method's schema, `data.issues` says where */
  invalidParams: -32602,
  internalError: -32603,
  /** A thread, turn, agent, entry, workflow or swarm that does not exist, `data.kind` says which */
  notFound: -32002,
  /** A method other than `initialize` before the client initialized */
  notInitialized: -32010,
  /** `initialize` sent a second time */
  alreadyInitialized: -32011,
  /** The thread has a turn going on */
  threadBusy: -32020,
  /** The turn named is not the one going on in the thread, or none is */
  turnNotActive: -32021,
  /** The thread waits on approvals or answers: resume it with `turn/start` and `resume` */
  threadPaused: -32022,
  /** The thread is archived: unarchive it first */
  threadArchived: -32023,
  /** The runtime refused or failed the call, `data.code` holds its error code */
  runtimeError: -32030,
} as const;

export type AppServerErrorCode =
  (typeof APP_SERVER_ERROR_CODES)[keyof typeof APP_SERVER_ERROR_CODES];

export const NotFoundKindSchema = z.enum(['thread', 'turn', 'agent', 'entry', 'workflow', 'swarm']);

export type NotFoundKind = z.infer<typeof NotFoundKindSchema>;

export const ValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string().optional(),
});

/** The `data` of each app-server error that carries one */
export const InvalidParamsDataSchema = z.object({ issues: z.array(ValidationIssueSchema) });
export const NotFoundDataSchema = z.object({ kind: NotFoundKindSchema, id: z.string() });
export const ThreadBusyDataSchema = z.object({ threadId: z.string(), activeTurnId: z.string() });
export const TurnNotActiveDataSchema = z.object({
  threadId: z.string(),
  activeTurnId: z.string().optional(),
});
export const ThreadStateDataSchema = z.object({ threadId: z.string() });
export const RuntimeErrorDataSchema = z.object({ code: z.string() });
