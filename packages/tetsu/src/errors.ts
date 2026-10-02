import { errorBody, hook, HttpError, httpError } from '@tetsujs/core';
import type { ErrorBody } from '@tetsujs/core';
import { CogitatorError, ERROR_STATUS_CODES } from '@cogitator-ai/types';

/** The status a request is answered with when its client left before the answer was ready. */
export const CLIENT_CLOSED_REQUEST = 499;

function isErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

/** The HTTP status a `CogitatorError` maps to: its own, the one of its code, or `500`. */
export function cogitatorErrorStatus(error: CogitatorError): number {
  const status = error.statusCode ?? ERROR_STATUS_CODES[error.code] ?? 500;
  return isErrorStatus(status) ? status : 500;
}

/**
 * Answers a `CogitatorError` in the Tetsu envelope `{ status, message, error }`,
 * with `Retry-After` when the error says when to retry.
 */
export function cogitatorErrorResponse(error: CogitatorError): Response {
  const status = cogitatorErrorStatus(error);
  const headers = new Headers();
  if (error.retryAfter !== undefined && error.retryAfter > 0) {
    headers.set('retry-after', String(Math.ceil(error.retryAfter / 1000)));
  }
  return Response.json(errorBody(status, error.code, error.message), { status, headers });
}

/**
 * An `onError` hook that answers every `CogitatorError` with its status and code.
 *
 * `cogitatorController()` mounts one on each of its routes. Mount another on the
 * application to map errors thrown by your own routes the same way.
 */
export function cogitatorErrors() {
  return hook.onError((ctx) =>
    CogitatorError.isCogitatorError(ctx.error) ? cogitatorErrorResponse(ctx.error) : undefined
  );
}

export interface DescribedError {
  message: string;
  code: string;
  /** Whether the error is a failure of the server rather than an answer. */
  unexpected: boolean;
}

/** What a stream or a socket tells its client about an error. */
export function describeError(error: unknown): DescribedError {
  if (CogitatorError.isCogitatorError(error)) {
    return { message: error.message, code: error.code, unexpected: false };
  }
  if (error instanceof HttpError) {
    const fallback = errorBody(error.status);
    const body: Partial<ErrorBody> =
      typeof error.body === 'object' && error.body !== null ? error.body : {};
    const message = typeof error.body === 'string' ? error.body : body.message;
    return {
      message: typeof message === 'string' ? message : fallback.message,
      code: typeof body.error === 'string' ? body.error : fallback.error,
      unexpected: false,
    };
  }
  return { message: 'Internal server error', code: 'INTERNAL_SERVER_ERROR', unexpected: true };
}

export function isModuleNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND';
}

export async function importOptional<T>(load: () => Promise<T>, packageName: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw httpError(
        501,
        'PACKAGE_NOT_INSTALLED',
        `${packageName} is not installed: add it to use this endpoint`
      );
    }
    throw error;
  }
}

export function clientClosedRequest(): HttpError {
  return httpError(CLIENT_CLOSED_REQUEST, 'CLIENT_CLOSED_REQUEST', 'Client closed request');
}
