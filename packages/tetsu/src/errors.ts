import { errorBody, hook, HttpError, httpError } from '@tetsujs/core';
import type { ErrorBody } from '@tetsujs/core';
import { describeHttpError, errorHeaders, INTERNAL_ERROR } from '@cogitator-ai/server-shared';
import type { HttpErrorDescription } from '@cogitator-ai/server-shared';
import type { CogitatorError } from '@cogitator-ai/types';

/** The status a request is answered with when its client left before the answer was ready. */
export const CLIENT_CLOSED_REQUEST = 499;

/** An error the shared taxonomy describes, in the Tetsu envelope `{ status, message, error }` */
function describedResponse(described: HttpErrorDescription): Response {
  return Response.json(errorBody(described.status, described.code, described.message), {
    status: described.status,
    headers: errorHeaders(described),
  });
}

/**
 * Answers a `CogitatorError` in the Tetsu envelope `{ status, message, error }`,
 * with `Retry-After` when the error says when to retry.
 */
export function cogitatorErrorResponse(error: CogitatorError): Response {
  return describedResponse(describeHttpError(error) ?? INTERNAL_ERROR);
}

/**
 * An `onError` hook that answers every `CogitatorError` with its status, code and
 * `Retry-After`, and a swarm that ran out of time with `504 RUN_TIMEOUT`.
 *
 * `cogitatorController()` mounts one on each of its routes. Mount another on the
 * application to map errors thrown by your own routes the same way.
 */
export function cogitatorErrors() {
  return hook.onError((ctx) => {
    const described = describeHttpError(ctx.error);
    return described ? describedResponse(described) : undefined;
  });
}

/** The `HttpError` a refusal of the shared contract is thrown as, in the Tetsu envelope */
export function refusalError(refusal: HttpErrorDescription): HttpError {
  return httpError(refusal.status, refusal.code, refusal.message);
}

export interface DescribedError {
  message: string;
  code: string;
  /** Whether the error is a failure of the server rather than an answer. */
  unexpected: boolean;
}

/**
 * What a stream or a socket tells its client about an error. An error the client is not told
 * about is `INTERNAL_ERROR`, the code the streams and sockets of every adapter send, while the
 * JSON answer keeps Tetsu's own `500 INTERNAL_SERVER_ERROR`.
 */
export function describeError(error: unknown): DescribedError {
  const described = describeHttpError(error);
  if (described) {
    return { message: described.message, code: described.code, unexpected: false };
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
  return { message: INTERNAL_ERROR.message, code: INTERNAL_ERROR.code, unexpected: true };
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
