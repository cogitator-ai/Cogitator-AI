import type { Request, Response, NextFunction } from 'express';
import {
  INTERNAL_ERROR,
  describeHttpError,
  type HttpErrorDescription,
} from '@cogitator-ai/server-shared';
import { sendError, sendFailure } from '../routes/utils.js';

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMIT_EXCEEDED',
};

/** A 4xx error of Express or its body parser, told to the client as it is */
function asClientError(err: unknown): HttpErrorDescription | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const rawStatus: unknown = Reflect.get(err, 'status') ?? Reflect.get(err, 'statusCode');
  if (typeof rawStatus !== 'number' || rawStatus < 400 || rawStatus >= 500) return undefined;
  const message: unknown = Reflect.get(err, 'message');
  const type: unknown = Reflect.get(err, 'type');
  return {
    status: rawStatus,
    code: CLIENT_ERROR_CODES[rawStatus] ?? 'BAD_REQUEST',
    message:
      type === 'entity.parse.failed'
        ? 'Invalid JSON body'
        : typeof message === 'string'
          ? message
          : 'Bad request',
  };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }

  const described = describeHttpError(err) ?? asClientError(err);
  if (described) {
    sendFailure(res, described);
    return;
  }

  console.error('[CogitatorServer] Unhandled error:', err);
  sendFailure(res, INTERNAL_ERROR);
}

export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, 404, 'Not found', 'NOT_FOUND');
}
