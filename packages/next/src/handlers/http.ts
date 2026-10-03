import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

export const MAX_BODY_SIZE = 1024 * 1024;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
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

export async function readJsonBody(
  req: Request,
  maxSize: number = MAX_BODY_SIZE
): Promise<BodyResult> {
  if (!req.body) {
    return { ok: false, response: jsonError('Invalid JSON', 400) };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: jsonError('Payload too large', 413) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: jsonError('Failed to read request body', 400) };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: jsonError('Invalid JSON', 400) };
  }
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
