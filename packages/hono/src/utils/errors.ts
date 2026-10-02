import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CogitatorError, ERROR_STATUS_CODES } from '@cogitator-ai/types';
import type { ErrorResponse } from '../types.js';

export interface ResolvedError {
  status: ContentfulStatusCode;
  body: ErrorResponse;
}

export function isModuleNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

function isErrorStatus(status: number): status is ContentfulStatusCode {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

export function cogitatorErrorStatus(error: CogitatorError): ContentfulStatusCode {
  const status = error.statusCode ?? ERROR_STATUS_CODES[error.code] ?? 500;
  return isErrorStatus(status) ? status : 500;
}

export function resolveError(error: unknown, label: string): ResolvedError {
  if (CogitatorError.isCogitatorError(error)) {
    return {
      status: cogitatorErrorStatus(error),
      body: { error: { message: error.message, code: error.code } },
    };
  }

  console.error(`[CogitatorHono] ${label}:`, error);
  return {
    status: 500,
    body: { error: { message: 'Internal server error', code: 'INTERNAL' } },
  };
}
