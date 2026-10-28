/**
 * The state an MCP server gives the client between rounds of a call that asks the user
 * (`requestState` of protocol 2026-07-28): what the call waits on, signed with HMAC, bound to
 * the caller and the method, for the tool and arguments of the call, valid for a while
 */

import { randomBytes } from 'node:crypto';
import {
  createRequestStateCodec,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

/** An approval the person gave in an earlier round, for the request with `digest` */
export interface GrantedApproval {
  digest: string;
  approved: boolean;
  reason?: string;
}

/**
 * What a call waits on between two rounds, with the approvals it was given so far: an
 * approval (`pending` the digest of the request asked), a run waiting in this process
 * (`parked`), or the questions of `context.input.ask()` and what the tool kept (`tool`)
 */
export type CallState = {
  tool: string;
  digest: string;
  /** The arguments the call parsed in its first round, for its later rounds */
  args?: unknown;
  approvals?: GrantedApproval[];
} & (
  | {
      kind: 'approval';
      key: string;
      pending: string;
      /** The answers and kept state of `context.input` the run had when it asked */
      resume?: { responses: Record<string, unknown>; data?: unknown };
    }
  | { kind: 'parked'; id: string }
  | { kind: 'tool'; data?: unknown }
);

const GrantedApprovalSchema = z.object({
  digest: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});

const base = {
  tool: z.string(),
  digest: z.string(),
  args: z.unknown().optional(),
  approvals: z.array(GrantedApprovalSchema).optional(),
};

const CallStateSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('approval'),
    key: z.string(),
    pending: z.string(),
    resume: z
      .object({ responses: z.record(z.string(), z.unknown()), data: z.unknown().optional() })
      .optional(),
  }),
  z.object({ ...base, kind: z.literal('parked'), id: z.string() }),
  z.object({ ...base, kind: z.literal('tool'), data: z.unknown().optional() }),
]);

/** A state that did not verify: expired, tampered with, or signed by another key or for another caller */
export const REJECTED_STATE = Symbol('rejected requestState');

/** The verified state of a round, `REJECTED_STATE` for one that came back and did not verify */
export type VerifiedState = CallState | typeof REJECTED_STATE | undefined;

/** A random key for a server without `requestStateKey` */
export function randomStateKey(): Uint8Array {
  return randomBytes(32);
}

/**
 * The codec of the call states a server mints for `caller` (its user id, or `''`), valid for
 * `ttlMs`, and a `verify` that resolves `REJECTED_STATE` instead of failing the request
 */
export function callStateCodec(
  key: string | Uint8Array,
  caller: string,
  ttlMs: number
): {
  mint: (state: CallState, ctx: ServerContext) => Promise<string>;
  verify: (state: string, ctx: ServerContext) => Promise<CallState | typeof REJECTED_STATE>;
} {
  if (typeof key === 'string' ? Buffer.byteLength(key, 'utf8') < 32 : key.length < 32) {
    throw new RangeError('requestStateKey must be at least 32 bytes long');
  }
  const codec: RequestStateCodec<CallState> = createRequestStateCodec<CallState>({
    key,
    ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    bind: (ctx) => `${ctx.mcpReq.method}\0${caller}`,
  });
  return {
    mint: (state, ctx) => codec.mint(state, ctx),
    verify: async (state, ctx) => {
      try {
        const parsed = CallStateSchema.safeParse(await codec.verify(state, ctx));
        return parsed.success ? parsed.data : REJECTED_STATE;
      } catch {
        return REJECTED_STATE;
      }
    },
  };
}

export { callDigest } from '../digest';
