import {
  INTERNAL_ERROR,
  describeHttpError,
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
  console.error(`[CogitatorHono] ${label}:`, error);
  return INTERNAL_ERROR;
}
