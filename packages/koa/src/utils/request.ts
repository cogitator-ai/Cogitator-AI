import type { Context } from 'koa';
import { authorizeThreadAccess, type HttpErrorDescription } from '@cogitator-ai/server-shared';
import type { CogitatorState } from '../types.js';

export function getRequestBody(ctx: Context): unknown {
  return (ctx.request as Context['request'] & { body?: unknown }).body;
}

export function onClientDisconnect(ctx: Context, listener: () => void): void {
  const res = ctx.res;
  res.once('close', () => {
    if (!res.writableFinished) listener();
  });
}

/**
 * The refusal of a request that names a thread the router's `authorizeThread` keeps the
 * caller from, none when it may go on
 */
export function refuseThread(
  ctx: Context,
  threadId: string | undefined
): Promise<HttpErrorDescription | undefined> {
  const state = ctx.state as CogitatorState;
  return authorizeThreadAccess(state.cogitator.authorizeThread, state.auth, threadId);
}

/** The `deps` a run of this request gets from the router's `deps` hook, none without it */
export async function runDeps(ctx: Context): Promise<{ deps?: unknown }> {
  const deps = (ctx.state as CogitatorState).cogitator.deps;
  return deps ? { deps: await deps(ctx) } : {};
}
