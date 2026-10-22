import type { Context } from 'koa';
import {
  INTERNAL_ERROR,
  describeHttpError,
  errorEnvelope,
  errorHeaders,
  type HttpErrorDescription,
} from '@cogitator-ai/server-shared';

export function isModuleNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * How the server answers `error`: {@link describeHttpError}, or {@link INTERNAL_ERROR} for an
 * error the client is not told about, which is logged under `label`
 */
export function describeError(error: unknown, label: string): HttpErrorDescription {
  const described = describeHttpError(error);
  if (described) return described;
  console.error(`[CogitatorKoa] ${label}:`, error);
  return INTERNAL_ERROR;
}

/** Answers an error with the error envelope and its `Retry-After` */
export function sendError(ctx: Context, error: HttpErrorDescription): void {
  ctx.status = error.status;
  ctx.set(errorHeaders(error));
  ctx.body = errorEnvelope(error);
}

/** Answers `error` as {@link describeError} describes it */
export function respondWithError(ctx: Context, error: unknown, label: string): void {
  sendError(ctx, describeError(error, label));
}

export function invalidInput(ctx: Context, message: string): void {
  sendError(ctx, { status: 400, code: 'INVALID_INPUT', message });
}

export function notFound(ctx: Context, message: string): void {
  sendError(ctx, { status: 404, code: 'NOT_FOUND', message });
}

export function notInstalled(ctx: Context, label: 'Swarms' | 'Workflows'): void {
  sendError(ctx, { status: 501, code: 'UNIMPLEMENTED', message: `${label} package not installed` });
}
