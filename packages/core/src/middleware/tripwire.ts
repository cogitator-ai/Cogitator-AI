import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/** What a tripped guard reports, as `details` of its `GUARDRAIL_TRIPPED` error. */
export interface TripwireDetails {
  /** Why the guard stopped the run */
  reason: string;
  /** The middleware whose hook tripped */
  middleware?: string;
  /** Whatever the guard found, for logs and the application */
  info?: unknown;
}

/**
 * Stops the run as a guard that tripped: call it in a middleware hook when the run must not go
 * on, and the run fails with `GUARDRAIL_TRIPPED` (HTTP 400), the reason and `info` in
 * `details`, the middleware named. Unlike a tool error, which the model reads and works around,
 * a tripwire ends the run where it is.
 *
 * @example
 * ```ts
 * const noSecrets: RunMiddleware = {
 *   name: 'no-secrets',
 *   afterModel({ response }) {
 *     if (/sk-[A-Za-z0-9]{20,}/.test(response.content)) tripwire('The answer holds an API key');
 *   },
 * };
 * ```
 */
export function tripwire(reason: string, info?: unknown): never {
  throw new CogitatorError({
    message: `Guardrail tripped: ${reason}`,
    code: ErrorCode.GUARDRAIL_TRIPPED,
    details: { reason, ...(info !== undefined && { info }) } satisfies TripwireDetails,
  });
}

/** Whether `error` is a tripped guard, see `tripwire()`. */
export function isTripwire(error: unknown): error is CogitatorError & { details: TripwireDetails } {
  return CogitatorError.isCogitatorError(error) && error.code === ErrorCode.GUARDRAIL_TRIPPED;
}

/** `error` as the tripwire of `middleware`, when it is a tripwire nobody claimed yet. */
export function claimTripwire(error: unknown, middleware: string): unknown {
  if (!isTripwire(error) || error.details.middleware !== undefined) return error;
  return new CogitatorError({
    message: `Guardrail "${middleware}" tripped: ${error.details.reason}`,
    code: ErrorCode.GUARDRAIL_TRIPPED,
    details: { ...error.details, middleware } satisfies TripwireDetails,
    cause: error,
  });
}
