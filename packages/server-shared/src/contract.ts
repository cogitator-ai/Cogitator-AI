import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

/**
 * The server contract every Cogitator adapter keeps: limits the operator sets on what a client
 * may ask a run for, who may touch a thread, and how an error is answered.
 */

/**
 * Caps the operator puts on what a request may ask for. A request asks for at most the cap,
 * and one that asks for nothing gets the cap: a swarm then times out after `swarmTimeout`, and
 * a workflow runs at most `workflowMaxIterations` iterations and `workflowMaxConcurrency` nodes
 * at once.
 */
export interface RunLimits {
  /** Longest a swarm run may take, in ms */
  swarmTimeout?: number;
  /** Most iterations a workflow run may take */
  workflowMaxIterations?: number;
  /** Most workflow nodes that may run at once */
  workflowMaxConcurrency?: number;
}

/**
 * The limits, checked: each must be a positive integer, the timeout no longer than a timer can
 * hold.
 *
 * @throws Error naming the limit that is not
 */
export function checkRunLimits(limits: RunLimits | undefined): RunLimits | undefined {
  if (!limits) return undefined;
  for (const [name, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`limits.${name} must be a positive integer, got ${String(value)}`);
    }
  }
  if (limits.swarmTimeout !== undefined && limits.swarmTimeout > MAX_TIMER_MS) {
    throw new Error(`limits.swarmTimeout must be at most ${MAX_TIMER_MS} ms`);
  }
  return limits;
}

const MAX_TIMER_MS = 2_147_483_647;

/** The smaller of what a request asked for and the cap, the cap when it asked for nothing */
function capped(requested: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return requested;
  return requested === undefined ? cap : Math.min(requested, cap);
}

/** The timeout a swarm run gets: the request's, at most `limits.swarmTimeout` */
export function swarmTimeoutWithin(
  requested: number | undefined,
  limits: RunLimits | undefined
): number | undefined {
  return capped(requested, limits?.swarmTimeout);
}

/** Workflow run options with `maxIterations` and `maxConcurrency` held to the limits */
export function workflowOptionsWithin<
  T extends { maxIterations?: number; maxConcurrency?: number },
>(options: T, limits: RunLimits | undefined): T {
  const maxIterations = capped(options.maxIterations, limits?.workflowMaxIterations);
  const maxConcurrency = capped(options.maxConcurrency, limits?.workflowMaxConcurrency);
  return {
    ...options,
    ...(maxIterations !== undefined && { maxIterations }),
    ...(maxConcurrency !== undefined && { maxConcurrency }),
  };
}

/**
 * Decides whether a caller may touch a thread, on top of the ownership check of core: called
 * with what authentication returned (undefined for a caller without it) and the thread a
 * request names. Answering `false` refuses the request with `403 THREAD_FORBIDDEN`.
 */
export type AuthorizeThread<Auth = unknown> = (
  auth: Auth | undefined,
  threadId: string
) => boolean | Promise<boolean>;

/**
 * Whether a caller without a user id may use the server: `'allow'` (the default) lets them in,
 * `'deny'` answers `401 UNAUTHORIZED`
 */
export type AnonymousPolicy = 'allow' | 'deny';

/** A refusal the server answers with: the status, the error code and what it tells the client */
export interface HttpErrorDescription {
  status: number;
  code: string;
  message: string;
  /** Seconds the client should wait before it tries again, sent as `Retry-After` */
  retryAfter?: number;
  /** The last checkpoint a failed workflow run saved, to resume it from */
  checkpointId?: string;
}

/** A caller the anonymous policy turns away */
export const UNAUTHORIZED: HttpErrorDescription = {
  status: 401,
  code: 'UNAUTHORIZED',
  message: 'Authentication required',
};

/** The refusal for a caller `authorizeThread` turned away from a thread */
export function threadForbidden(threadId: string): HttpErrorDescription {
  return {
    status: 403,
    code: 'THREAD_FORBIDDEN',
    message: `Access to thread '${threadId}' is not allowed`,
  };
}

/** The refusal of a caller without a user id under `anonymous`, none when they may go on */
export function admitCaller(
  userId: string | undefined,
  anonymous: AnonymousPolicy | undefined
): HttpErrorDescription | undefined {
  return anonymous === 'deny' && userId === undefined ? UNAUTHORIZED : undefined;
}

/**
 * The refusal `authorizeThread` gives a request that names a thread, none when it may go on or
 * names no thread
 */
export async function authorizeThreadAccess<Auth>(
  authorize: AuthorizeThread<Auth> | undefined,
  auth: Auth | undefined,
  threadId: string | undefined
): Promise<HttpErrorDescription | undefined> {
  if (!authorize || threadId === undefined) return undefined;
  return (await authorize(auth, threadId)) ? undefined : threadForbidden(threadId);
}

function isErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

/** The HTTP status a `CogitatorError` maps to: its own, the one of its code, or `500` */
export function cogitatorErrorStatus(error: CogitatorError): number {
  const status = error.statusCode ?? ERROR_STATUS_CODES[error.code] ?? 500;
  return isErrorStatus(status) ? status : 500;
}

/** The longest wait `Retry-After` asks for, a day, whatever the provider said */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** The whole seconds of a `retryAfter` in ms, as `Retry-After` carries them, at most a day */
export function retryAfterSeconds(retryAfterMs: number | undefined): number | undefined {
  return retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(Math.ceil(retryAfterMs / 1000), MAX_RETRY_AFTER_SECONDS)
    : undefined;
}

/**
 * How the server answers an error a run or a route threw: a `CogitatorError` with its status,
 * code and `Retry-After`, a swarm that ran out of time with `504 RUN_TIMEOUT`, and anything
 * else as `undefined`, an internal error the server logs and answers with
 * {@link INTERNAL_ERROR} without telling the client what went wrong
 */
export function describeHttpError(error: unknown): HttpErrorDescription | undefined {
  if (CogitatorError.isCogitatorError(error)) {
    const retryAfter = retryAfterSeconds(error.retryAfter);
    return {
      status: cogitatorErrorStatus(error),
      code: error.code,
      message: error.message,
      ...(retryAfter !== undefined && { retryAfter }),
    };
  }
  if (error instanceof Error && error.name === 'SwarmTimeoutError') {
    return { status: 504, code: ErrorCode.RUN_TIMEOUT, message: error.message };
  }
  return undefined;
}

/** The answer to an error the client is not told about */
export const INTERNAL_ERROR: HttpErrorDescription = {
  status: 500,
  code: ErrorCode.INTERNAL_ERROR,
  message: 'Internal server error',
};

/** The error envelope every adapter but Tetsu answers with */
export interface ErrorEnvelope {
  error: {
    message: string;
    code: string;
    /** The last checkpoint a failed workflow run saved: resume the run from it */
    checkpointId?: string;
  };
}

/** The body of an answer to an error */
export function errorEnvelope(error: HttpErrorDescription): ErrorEnvelope {
  return {
    error: {
      message: error.message,
      code: error.code,
      ...(error.checkpointId !== undefined && { checkpointId: error.checkpointId }),
    },
  };
}

/**
 * How a failed workflow run is answered: as `described`, with the last checkpoint the run saved
 * when it saved one, so the client can resume it with `/workflows/:name/resume`
 */
export function workflowRunFailure(
  described: HttpErrorDescription,
  checkpointId: string | undefined
): HttpErrorDescription {
  return checkpointId === undefined ? described : { ...described, checkpointId };
}

/** The headers of an answer to an error: `Retry-After` when the error says when to retry */
export function errorHeaders(error: HttpErrorDescription): Record<string, string> {
  return error.retryAfter !== undefined ? { 'Retry-After': String(error.retryAfter) } : {};
}
