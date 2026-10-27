import type { Request, Response } from 'express';
import {
  INTERNAL_ERROR,
  authorizeThreadAccess,
  describeHttpError,
  errorEnvelope,
  errorHeaders,
  type HttpErrorDescription,
  type ParseResult,
} from '@cogitator-ai/server-shared';
import type { CogitatorRequest, RouteContext } from '../types.js';

/** Answers an error with the shared envelope and its `Retry-After` */
export function sendFailure(res: Response, error: HttpErrorDescription): void {
  for (const [name, value] of Object.entries(errorHeaders(error))) res.setHeader(name, value);
  res.status(error.status).json(errorEnvelope(error));
}

export function sendError(res: Response, status: number, message: string, code: string): void {
  sendFailure(res, { status, code, message });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
  );
}

/**
 * What a client may see of an error: what `describeHttpError` makes of it, or, for an
 * internal error, `500 Internal server error` after it is logged under `label`
 */
export function resolveError(error: unknown, label: string): HttpErrorDescription {
  const described = describeHttpError(error);
  if (described) return described;
  console.error(`[CogitatorServer] ${label}:`, error);
  return INTERNAL_ERROR;
}

export function handleRouteError(res: Response, error: unknown, label: string): void {
  if (res.headersSent) return;
  sendFailure(res, resolveError(error, label));
}

/**
 * Calls `handler` once the client goes away before the answer ended, also when it already went
 * away: a request can lose its client while a route awaits (the store creating a stream, the
 * `deps` hook), and a `close` that fired then would never reach a handler added later
 */
export function onClientDisconnect(res: Response, handler: () => void): void {
  if (res.closed) {
    if (!res.writableEnded) handler();
    return;
  }
  res.on('close', () => {
    if (!res.writableEnded) handler();
  });
}

/**
 * Whether a request may go on to the thread it names: answers the refusal of
 * `authorizeThread`, or the error it threw, and says `false` then
 */
export async function admitThread<P extends Request['params']>(
  ctx: RouteContext,
  req: CogitatorRequest<P>,
  res: Response,
  threadId: string | undefined,
  label: string
): Promise<boolean> {
  try {
    const refusal = await authorizeThreadAccess(
      ctx.config.authorizeThread,
      req.cogitator?.auth,
      threadId
    );
    if (!refusal) return true;
    sendFailure(res, refusal);
  } catch (error) {
    handleRouteError(res, error, label);
  }
  return false;
}

/** The `deps` an agent run gets for a request from the `deps` hook, none without the hook */
export async function requestDeps<P extends Request['params']>(
  ctx: RouteContext,
  req: Request<P>
): Promise<{ deps?: unknown }> {
  return ctx.config.deps ? { deps: await ctx.config.deps(req) } : {};
}

/**
 * Admits an agent run, stream or resume on the thread it names and builds its `deps`:
 * the options to start it with, or `undefined` once the request was answered
 */
export async function admitAgentRun<P extends Request['params']>(
  ctx: RouteContext,
  req: CogitatorRequest<P>,
  res: Response,
  threadId: string | undefined,
  label: string
): Promise<{ deps?: unknown } | undefined> {
  if (!(await admitThread(ctx, req, res, threadId, label))) return undefined;
  try {
    return await requestDeps(ctx, req);
  } catch (error) {
    handleRouteError(res, error, label);
    return undefined;
  }
}

export type { ParseResult };
