import type { Context } from 'koa';

export function getRequestBody(ctx: Context): unknown {
  return (ctx.request as Context['request'] & { body?: unknown }).body;
}

export function onClientDisconnect(ctx: Context, listener: () => void): void {
  const res = ctx.res;
  res.once('close', () => {
    if (!res.writableFinished) listener();
  });
}
