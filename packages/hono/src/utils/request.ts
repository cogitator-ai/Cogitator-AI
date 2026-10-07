import type { Context } from 'hono';
import { isJsonObject, parseJsonBody, type BodyRefusal } from '@cogitator-ai/server-shared';
import type { HonoEnv } from '../types.js';
import { resolveError } from './errors.js';

export type { JsonBodyResult } from '@cogitator-ai/server-shared';

/**
 * Reads the JSON body of a request: `undefined` for no body, a refusal for a body that is
 * not JSON (`415`) or not valid JSON (`400`). Only JSON media types are read, so a page on
 * another origin cannot start a run with a `text/plain` or form body, which browsers send
 * without a CORS preflight.
 */
export async function readJsonBody(c: Context<HonoEnv>) {
  return parseJsonBody(c.req.header('content-type'), await c.req.text());
}

/** Answers a body that {@link readJsonBody} refused */
export function bodyRefused(c: Context<HonoEnv>, refusal: BodyRefusal): Response {
  return c.json({ error: { message: refusal.message, code: refusal.code } }, refusal.status);
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

export function errorResponse(c: Context<HonoEnv>, error: unknown, label: string): Response {
  const { status, body } = resolveError(error, label);
  return c.json(body, status);
}

export function requestAborted(c: Context<HonoEnv>): Response {
  return c.json({ error: { message: 'Request aborted', code: 'ABORTED' } }, 400);
}
