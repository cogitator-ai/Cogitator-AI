import { readJsonRequestBody } from '@cogitator-ai/server-shared';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

export const MAX_BODY_SIZE = 1024 * 1024;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonError(message: string, status: number, code?: string): Response {
  return jsonResponse(code === undefined ? { error: message } : { error: message, code }, status);
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

export function hookErrorResponse(err: unknown, fallbackMessage: string): Response {
  return jsonError(
    err instanceof Error ? err.message : fallbackMessage,
    readErrorStatus(err) ?? 401
  );
}

function isErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status < 600;
}

function cogitatorErrorStatus(error: CogitatorError): number {
  const status = error.statusCode ?? ERROR_STATUS_CODES[error.code] ?? 500;
  return isErrorStatus(status) ? status : 500;
}

export interface RunErrorDescription {
  message: string;
  code: string;
  status: number;
}

/**
 * What a client may see of a failed run: a `CogitatorError` with its message,
 * `code` and status (for example `403 THREAD_ACCESS_DENIED`); any other error
 * is logged and reported only as `500 Internal server error`, since its text
 * can carry internals such as connection strings.
 */
export function describeRunError(err: unknown): RunErrorDescription {
  if (CogitatorError.isCogitatorError(err)) {
    return { message: err.message, code: err.code, status: cogitatorErrorStatus(err) };
  }
  console.error('[cogitator] Run failed:', err);
  return { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR, status: 500 };
}

/** Answers a failed run as {@link describeRunError} describes it. */
export function runErrorResponse(err: unknown): Response {
  const { message, code, status } = describeRunError(err);
  return jsonResponse({ error: message, code }, status);
}
