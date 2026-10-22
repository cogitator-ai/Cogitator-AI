import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  authorizeThreadAccess,
  errorEnvelope,
  errorHeaders,
  isJsonObject,
  parseJsonBody,
  type BodyRefusal,
  type HttpErrorDescription,
} from '@cogitator-ai/server-shared';
import type { HonoEnv } from '../types.js';
import { describeError } from './errors.js';

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

function isContentfulErrorStatus(status: number): status is ContentfulStatusCode {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

/** Answers an error with the error envelope and its `Retry-After` */
export function sendError(c: Context<HonoEnv>, error: HttpErrorDescription): Response {
  const status = isContentfulErrorStatus(error.status) ? error.status : 500;
  return c.json(errorEnvelope(error), status, errorHeaders(error));
}

/** Answers a body that {@link readJsonBody} refused */
export function bodyRefused(c: Context<HonoEnv>, refusal: BodyRefusal): Response {
  return sendError(c, refusal);
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
  return sendError(c, { status: 400, code: 'INVALID_INPUT', message });
}

export function notFound(c: Context<HonoEnv>, message: string): Response {
  return sendError(c, { status: 404, code: 'NOT_FOUND', message });
}

export function notInstalled(c: Context<HonoEnv>, label: 'Swarms' | 'Workflows'): Response {
  return sendError(c, {
    status: 501,
    code: 'UNIMPLEMENTED',
    message: `${label} package not installed`,
  });
}

export function errorResponse(c: Context<HonoEnv>, error: unknown, label: string): Response {
  return sendError(c, describeError(error, label));
}

export function requestAborted(c: Context<HonoEnv>): Response {
  return sendError(c, { status: 400, code: 'ABORTED', message: 'Request aborted' });
}

/**
 * The refusal of a request that names a thread the app's `authorizeThread` keeps the caller
 * from, none when it may go on
 */
export function refuseThread(
  c: Context<HonoEnv>,
  threadId: string | undefined
): Promise<HttpErrorDescription | undefined> {
  return authorizeThreadAccess(
    c.get('cogitator').authorizeThread,
    c.get('cogitatorAuth'),
    threadId
  );
}

/** The `deps` a run of this request gets from the app's `deps` hook, none without it */
export async function runDeps(c: Context<HonoEnv>): Promise<{ deps?: unknown }> {
  const deps = c.get('cogitator').deps;
  return deps ? { deps: await deps(c) } : {};
}
