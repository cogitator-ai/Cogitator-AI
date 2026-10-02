import type { Request, Response, NextFunction } from 'express';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

interface HttpLikeError {
  status: number;
  message: string;
  type?: string;
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMIT_EXCEEDED',
};

function asClientError(err: unknown): HttpLikeError | null {
  if (typeof err !== 'object' || err === null) return null;
  const rawStatus: unknown = Reflect.get(err, 'status') ?? Reflect.get(err, 'statusCode');
  if (typeof rawStatus !== 'number' || rawStatus < 400 || rawStatus >= 500) return null;
  const message: unknown = Reflect.get(err, 'message');
  const type: unknown = Reflect.get(err, 'type');
  return {
    status: rawStatus,
    message: typeof message === 'string' ? message : 'Bad request',
    type: typeof type === 'string' ? type : undefined,
  };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }

  if (CogitatorError.isCogitatorError(err)) {
    const statusCode = ERROR_STATUS_CODES[err.code] || 500;
    res.status(statusCode).json({
      error: {
        message: err.message,
        code: err.code,
      },
    });
    return;
  }

  const clientError = asClientError(err);
  if (clientError) {
    const message =
      clientError.type === 'entity.parse.failed' ? 'Invalid JSON body' : clientError.message;
    res.status(clientError.status).json({
      error: {
        message,
        code: CLIENT_ERROR_CODES[clientError.status] ?? 'BAD_REQUEST',
      },
    });
    return;
  }

  console.error('[CogitatorServer] Unhandled error:', err);

  res.status(500).json({
    error: {
      message: 'Internal server error',
      code: ErrorCode.INTERNAL_ERROR,
    },
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: 'Not found',
      code: 'NOT_FOUND',
    },
  });
}
