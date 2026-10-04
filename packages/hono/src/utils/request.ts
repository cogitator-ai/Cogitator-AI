import type { Context } from 'hono';
import { isJsonObject } from '@cogitator-ai/server-shared';
import type { HonoEnv } from '../types.js';
import { resolveError } from './errors.js';

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false };

export async function readJsonBody(c: Context<HonoEnv>): Promise<JsonBodyResult> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createRequestAbortController(c: Context<HonoEnv>): AbortController {
  const controller = new AbortController();
  const signal = c.req.raw.signal;
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

/** The part of a `Bun.serve` server that sets the idle timeout of one request */
interface BunServerLike {
  timeout(request: Request, seconds: number): void;
  requestIP(request: Request): unknown;
}

function isBunServer(value: unknown): value is BunServerLike {
  return (
    isJsonObject(value) &&
    typeof value.timeout === 'function' &&
    typeof value.requestIP === 'function'
  );
}

/**
 * Keeps the connection of a request that waits on a run open for as long as the run takes.
 *
 * On Bun, `Bun.serve` hands its server to `fetch` (Hono's `c.env`, or `c.env.server`) and
 * closes a connection that stays silent for `idleTimeout` seconds, 10 by default. A JSON
 * answer has nothing to send until the run ends, so any run longer than that would be cut
 * off. This lifts the idle timeout for this one request, after its body was read. On other
 * runtimes it does nothing.
 */
export function holdConnectionOpen(c: Context<HonoEnv>): void {
  const env: unknown = c.env;
  const server = isJsonObject(env) && 'server' in env ? env.server : env;
  if (isBunServer(server)) server.timeout(c.req.raw, 0);
}

export function invalidInput(c: Context<HonoEnv>, message: string): Response {
  return c.json({ error: { message, code: 'INVALID_INPUT' } }, 400);
}

export function invalidJson(c: Context<HonoEnv>): Response {
  return invalidInput(c, 'Invalid JSON body');
}

export function errorResponse(c: Context<HonoEnv>, error: unknown, label: string): Response {
  const { status, body } = resolveError(error, label);
  return c.json(body, status);
}

export function requestAborted(c: Context<HonoEnv>): Response {
  return c.json({ error: { message: 'Request aborted', code: 'ABORTED' } }, 400);
}
