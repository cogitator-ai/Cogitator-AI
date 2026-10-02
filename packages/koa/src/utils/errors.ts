import { CogitatorError, ERROR_STATUS_CODES } from '@cogitator-ai/types';
import type { ErrorResponse } from '../types.js';

export interface ResolvedError {
  status: number;
  body: ErrorResponse;
}

export function isModuleNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

export function resolveError(error: unknown, label: string): ResolvedError {
  if (CogitatorError.isCogitatorError(error)) {
    return {
      status: error.statusCode ?? ERROR_STATUS_CODES[error.code] ?? 500,
      body: { error: { message: error.message, code: error.code } },
    };
  }

  console.error(`[CogitatorKoa] ${label}:`, error);
  return {
    status: 500,
    body: { error: { message: 'Internal server error', code: 'INTERNAL' } },
  };
}
