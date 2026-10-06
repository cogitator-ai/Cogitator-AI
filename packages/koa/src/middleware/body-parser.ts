import { refuseNonJsonBody } from '@cogitator-ai/server-shared';
import type { Context, Next } from 'koa';

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

export interface BodyParserOptions {
  limit?: number;
}

export function createBodyParser(options: BodyParserOptions = {}) {
  const limit = options.limit ?? DEFAULT_BODY_LIMIT;

  return async (ctx: Context, next: Next) => {
    const refusal = refuseNonJsonBody(ctx.method, ctx.headers);
    if (refusal) {
      await discardBody(ctx);
      ctx.status = refusal.status;
      ctx.body = { error: { message: refusal.message, code: refusal.code } };
      return;
    }
    if (BODY_METHODS.has(ctx.method) && ctx.is('application/json') && !isBodyConsumed(ctx)) {
      const declaredLength = Number(ctx.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        await discardBody(ctx);
        throw new PayloadTooLargeError();
      }

      const raw = await readBody(ctx, limit);
      if (raw.trim()) {
        try {
          (ctx.request as Context['request'] & { body?: unknown }).body = JSON.parse(raw);
        } catch {
          ctx.status = 400;
          ctx.body = { error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } };
          return;
        }
      }
    }
    await next();
  };
}

function isBodyConsumed(ctx: Context): boolean {
  return (
    (ctx.request as Context['request'] & { body?: unknown }).body !== undefined ||
    ctx.req.readableEnded
  );
}

function discardBody(ctx: Context): Promise<void> {
  const req = ctx.req;
  if (req.readableEnded || req.destroyed) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      req.off('end', done);
      req.off('close', done);
      req.off('error', done);
      resolve();
    };
    req.on('end', done);
    req.on('close', done);
    req.on('error', done);
    req.resume();
  });
}

function readBody(ctx: Context, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = ctx.req;
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        settle(() => {
          void discardBody(ctx).then(() => reject(new PayloadTooLargeError()));
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onError = (err: Error) => settle(() => reject(err));
    const onClose = () => settle(() => reject(new RequestAbortedError()));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

class PayloadTooLargeError extends Error {
  readonly status = 413;
  readonly expose = true;

  constructor() {
    super('Payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

class RequestAbortedError extends Error {
  readonly status = 400;
  readonly expose = true;

  constructor() {
    super('Request aborted');
    this.name = 'RequestAbortedError';
  }
}
