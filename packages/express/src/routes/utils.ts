import type { Response } from 'express';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';
import type { ParseResult } from '@cogitator-ai/server-shared';

export function sendError(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: { message, code } });
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

export interface ResolvedError {
  status: number;
  message: string;
  code: string;
}

export function resolveError(error: unknown, label: string): ResolvedError {
  if (CogitatorError.isCogitatorError(error)) {
    return {
      status: ERROR_STATUS_CODES[error.code] || 500,
      message: error.message,
      code: error.code,
    };
  }
  console.error(`[CogitatorServer] ${label}:`, error);
  return { status: 500, message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR };
}

export function handleRouteError(res: Response, error: unknown, label: string): void {
  if (res.headersSent) return;
  const resolved = resolveError(error, label);
  sendError(res, resolved.status, resolved.message, resolved.code);
}

export function onClientDisconnect(res: Response, handler: () => void): void {
  res.on('close', () => {
    if (!res.writableEnded) handler();
  });
}

export type { ParseResult };
