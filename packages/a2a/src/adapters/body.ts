import type { IncomingMessage } from 'node:http';

/** The largest request body an adapter reads itself, in bytes (1 MiB). */
export const A2A_BODY_LIMIT = 1024 * 1024;

/** A request body over the limit, answered with HTTP 413. */
export class PayloadTooLargeError extends Error {
  readonly status = 413;

  constructor(readonly limit: number) {
    super(`Request body larger than ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

/** Whether a body parser left an empty object in place of a body it did not read. */
export function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function discard(req: IncomingMessage): void {
  if (!req.readableEnded && !req.destroyed) req.resume();
}

/**
 * The body of a request as text, at most `limit` bytes: a declared or streamed body over the
 * limit is drained and rejects with `PayloadTooLargeError`.
 */
export function readRawBody(req: IncomingMessage, limit = A2A_BODY_LIMIT): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    discard(req);
    return Promise.reject(new PayloadTooLargeError(limit));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      action();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limit) {
        settle(() => {
          discard(req);
          reject(new PayloadTooLargeError(limit));
        });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onError = (error: Error) => settle(() => reject(error));
    const onClose = () => settle(() => reject(new Error('Request aborted')));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}
