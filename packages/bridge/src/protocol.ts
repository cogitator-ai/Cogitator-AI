import { z } from 'zod';
import { JsonRpcCallError, type JsonRpcError } from '@cogitator-ai/server-shared';
import { BridgeError, type BridgeErrorCode } from './errors.js';
import { CallerIdentitySchema, type AgentRecord } from './types.js';
import type { DispatcherStatus } from './dispatcher.js';

/** The version of the protocol the dispatcher speaks on its socket. */
export const BRIDGE_PROTOCOL_VERSION = 2;

/** The JSON-RPC methods of the dispatcher. */
export const BRIDGE_METHODS = {
  hello: 'bridge/hello',
  status: 'bridge/status',
  createJob: 'jobs/create',
  getJob: 'jobs/get',
  listJobs: 'jobs/list',
  cancelJob: 'jobs/cancel',
  diff: 'jobs/diff',
  accept: 'jobs/accept',
  reject: 'jobs/reject',
  send: 'letters/send',
  inbox: 'letters/inbox',
  acknowledge: 'letters/acknowledge',
  wait: 'letters/wait',
  delivered: 'letters/delivered',
  escalate: 'letters/escalate',
  verdict: 'letters/verdict',
  withdraw: 'letters/withdraw',
  listLetters: 'letters/list',
  forPerson: 'person/letters',
  personAnswer: 'person/answer',
  listAgents: 'agents/list',
  stuck: 'agents/stuck',
  remember: 'facts/remember',
  recall: 'facts/recall',
  forget: 'facts/forget',
  readJournal: 'journal/read',
  subscribeJournal: 'journal/subscribe',
  unsubscribeJournal: 'journal/unsubscribe',
} as const;

/** What the dispatcher sends without being asked. */
export const BRIDGE_NOTIFICATIONS = {
  /** An entry of the journal, to a connection that subscribed */
  journalEntry: 'journal/entry',
} as const;

/** The JSON-RPC error code of every refusal of the bridge. Which one it is lies in `data.code`. */
export const BRIDGE_ERROR_CODE = -32001;

export const HelloParamsSchema = z.object({
  /** The session calling. Without it the connection can read, and cannot act as an agent */
  caller: CallerIdentitySchema.optional(),
  protocol: z.number().int().positive().optional(),
});

export const JobNumberParamsSchema = z.object({ job: z.number().int().positive() });

export const CancelJobParamsSchema = z.object({
  job: z.number().int().positive(),
  reason: z.string().max(2000).optional(),
});

export const AcknowledgeParamsSchema = z.object({ letter: z.string().min(1).max(128) });

export const DeliveredParamsSchema = z.object({
  letters: z.array(z.string().min(1).max(128)).min(1).max(100),
});

export const SubscribeJournalParamsSchema = z.object({
  /** Only the entries of one job */
  job: z.number().int().positive().optional(),
});

/** The dispatcher a connection reached. */
export interface DispatcherInfo {
  pid: number;
  version: string;
  protocol: number;
  /** ISO 8601 */
  startedAt: string;
  socket: string;
  database: string;
}

export interface HelloResult {
  dispatcher: DispatcherInfo;
  /** The agent the connection acts as, when it said who is calling */
  agent?: AgentRecord;
}

export interface BridgeStatus extends DispatcherStatus {
  dispatcher: DispatcherInfo;
}

/** A refusal of the bridge as it travels over JSON-RPC. */
export function toJsonRpcError(error: BridgeError): JsonRpcError {
  return {
    code: BRIDGE_ERROR_CODE,
    message: error.message,
    data: { ...error.data, code: error.code },
  };
}

/** The refusal a JSON-RPC error carries, or the error itself when it is something else. */
export function fromJsonRpcError(error: unknown): unknown {
  if (!(error instanceof JsonRpcCallError) || error.code !== BRIDGE_ERROR_CODE) return error;
  const data = error.data;
  if (typeof data !== 'object' || data === null || !('code' in data)) return error;
  const { code, ...rest } = data as { code: unknown } & Record<string, unknown>;
  if (typeof code !== 'string') return error;
  return new BridgeError(
    code as BridgeErrorCode,
    error.message,
    Object.keys(rest).length > 0 ? rest : undefined
  );
}
