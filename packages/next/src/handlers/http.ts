import {
  INTERNAL_ERROR,
  admitCaller,
  authorizeThreadAccess,
  describeHttpError,
  errorEnvelope,
  errorHeaders,
  readJsonRequestBody,
  type HttpErrorDescription,
} from '@cogitator-ai/server-shared';
import type { ServerContractOptions } from '../types.js';

export const MAX_BODY_SIZE = 1024 * 1024;

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Answers a refusal in the envelope every Cogitator adapter uses, `{ error: { message, code } }`,
 * with `Retry-After` when the refusal says when to retry
 */
export function errorResponse(error: HttpErrorDescription): Response {
  return jsonResponse(errorEnvelope(error), error.status, errorHeaders(error));
}

export function jsonError(message: string, status: number, code: string): Response {
  return errorResponse({ status, code, message });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exceedsDeclaredSize(req: Request, maxSize: number = MAX_BODY_SIZE): boolean {
  const header = req.headers.get('content-length');
  if (header === null) return false;
  const declared = Number(header);
  return Number.isFinite(declared) && declared > maxSize;
}

export type BodyResult = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Reads a JSON body of at most `maxSize` bytes. Only JSON media types are read: browsers send
 * `text/plain` and form bodies across origins without a CORS preflight, so reading those as
 * JSON would let any page start a run. A refused body answers `415`, `413` or `400`.
 */
export async function readJsonBody(
  req: Request,
  maxSize: number = MAX_BODY_SIZE
): Promise<BodyResult> {
  const read = await readJsonRequestBody(req, maxSize);
  if (!read.ok) {
    const { message, status, code } = read.refusal;
    return { ok: false, response: jsonError(message, status, code) };
  }
  if (read.value === undefined) {
    return { ok: false, response: jsonError('Invalid JSON', 400, 'INVALID_INPUT') };
  }
  return { ok: true, body: read.value };
}

function readErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const { status } = err;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : undefined;
}

function readErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' && err.code ? err.code : undefined;
}

/**
 * Answers a hook that threw. A `CogitatorError` answers as a failed run would, and an error that
 * sets a client error `status` (`400` to `499`) on purpose answers with that status, its message
 * and its `code`. Anything else, an error the hook did not mean to answer with (a session store
 * that is down, say), is logged and answered `401 Unauthorized` without its text or code, which
 * can carry internals such as addresses.
 */
export function hookErrorResponse(err: unknown, fallbackMessage: string): Response {
  const described = describeHttpError(err);
  if (described) return errorResponse(described);
  const status = readErrorStatus(err);
  if (status !== undefined && status < 500) {
    return jsonError(
      err instanceof Error && err.message ? err.message : fallbackMessage,
      status,
      readErrorCode(err) ?? (status === 401 ? 'UNAUTHORIZED' : 'REQUEST_REFUSED')
    );
  }
  console.error('[cogitator] A request hook failed:', err);
  return jsonError(fallbackMessage, 401, 'UNAUTHORIZED');
}

/** What a client may see of a failed run, its status, code and `Retry-After` */
export type RunErrorDescription = HttpErrorDescription;

/**
 * What a client may see of a failed run: a `CogitatorError` with its message, `code`, status
 * (for example `403 THREAD_ACCESS_DENIED`) and `Retry-After`; any other error is logged and
 * reported only as `500 Internal server error`, since its text can carry internals such as
 * connection strings.
 */
export function describeRunError(err: unknown): RunErrorDescription {
  const described = describeHttpError(err);
  if (described) return described;
  console.error('[cogitator] Run failed:', err);
  return INTERNAL_ERROR;
}

/** Answers a failed run as {@link describeRunError} describes it. */
export function runErrorResponse(err: unknown): Response {
  return errorResponse(describeRunError(err));
}

/**
 * The refusal of a request the server contract turns away, none when it may go on: a caller
 * without a user id (`userId` of what `beforeRun` returned) under `anonymous: 'deny'`, or a
 * thread `authorizeThread` keeps the caller from
 */
export async function refuseRequest(
  req: Request,
  threadId: string | undefined,
  runContext: Record<string, unknown>,
  options: ServerContractOptions | undefined
): Promise<Response | undefined> {
  const userId = typeof runContext.userId === 'string' ? runContext.userId : undefined;
  const authorize = options?.authorizeThread;
  const refusal =
    admitCaller(userId, options?.anonymous) ??
    (await authorizeThreadAccess(
      authorize && ((_req: Request | undefined, id: string) => authorize(req, id)),
      req,
      threadId
    ));
  return refusal && errorResponse(refusal);
}

/**
 * The thread a run goes to: the one `beforeRun` returned, which the run options take over the
 * request's, else the one the request named
 */
export function threadOf(
  runContext: Record<string, unknown>,
  input: { threadId?: string }
): string | undefined {
  return typeof runContext.threadId === 'string' ? runContext.threadId : input.threadId;
}

/**
 * The signal a run stops on: the request's, and the `signal` `beforeRun` returned when it returned
 * one, whichever aborts first
 */
export function runSignal(
  signal: AbortSignal | undefined,
  runContext: Record<string, unknown>
): AbortSignal | undefined {
  const hook = runContext.signal instanceof AbortSignal ? runContext.signal : undefined;
  return signal && hook ? AbortSignal.any([signal, hook]) : (signal ?? hook);
}

/** The run options with the `deps` the server builds for the request, when it builds them */
export async function depsOf(
  req: Request,
  options: ServerContractOptions | undefined
): Promise<{ deps?: unknown }> {
  return options?.deps ? { deps: await options.deps(req) } : {};
}
