/**
 * The state an MCP server gives the client between rounds of a call that asks the user
 * (`requestState` of protocol 2026-07-28): what the call waits on, signed with HMAC, bound to
 * the caller and the method, for the tool and arguments of the call, valid for a while
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  createRequestStateCodec,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

/** What a call waits on between two rounds */
export type CallState =
  | { kind: 'approval'; tool: string; digest: string; key: string }
  | { kind: 'parked'; tool: string; digest: string; id: string }
  | { kind: 'tool'; tool: string; digest: string; data: unknown };

const CallStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), tool: z.string(), digest: z.string(), key: z.string() }),
  z.object({ kind: z.literal('parked'), tool: z.string(), digest: z.string(), id: z.string() }),
  z.object({ kind: z.literal('tool'), tool: z.string(), digest: z.string(), data: z.unknown() }),
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

/** A digest of a call: its tool and its arguments, keys in order */
export function callDigest(tool: string, args: unknown): string {
  return createHash('sha256')
    .update(tool)
    .update('\0')
    .update(stableJson(args))
    .digest('base64url');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
