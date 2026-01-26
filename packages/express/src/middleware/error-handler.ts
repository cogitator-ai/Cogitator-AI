import type { Request, Response, NextFunction } from 'express';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

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
      code: ErrorCode.AGENT_NOT_FOUND,
    },
  });
}
