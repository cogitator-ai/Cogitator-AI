import type { Context, Next } from 'koa';

const MAX_BODY_SIZE = 1024 * 1024;

export function createBodyParser() {
  return async (ctx: Context, next: Next) => {
    if (['POST', 'PUT', 'PATCH'].includes(ctx.method) && ctx.is('application/json')) {
      const body = await readBody(ctx);
      if (body) {
        try {
          (ctx.request as unknown as { body: unknown }).body = JSON.parse(body);
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

function readBody(ctx: Context): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    ctx.req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        ctx.req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    ctx.req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    ctx.req.on('error', reject);
  });
}

class PayloadTooLargeError extends Error {
  status = 413;
  constructor() {
    super('Payload too large');
  }
}
