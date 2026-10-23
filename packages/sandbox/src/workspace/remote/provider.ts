import { WorkspaceError } from '@cogitator-ai/types';
import { message } from '../exec-stream';

/**
 * What `dispose()` does with the sandbox: `destroy` removes it, `stop` stops it (its files are
 * kept and it can be started again), `keep` leaves it running for whoever comes next.
 */
export type RemoteSandboxDisposal = 'destroy' | 'stop' | 'keep';

/** `explicit`, else the environment variable `name`, `undefined` when neither is set. */
export function setting(explicit: string | undefined, name: string): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit;
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** The error a workspace fails with when the provider's SDK is not installed. */
export function missingSdk(workspace: string, pkg: string, error: unknown): WorkspaceError {
  return new WorkspaceError(
    'UNAVAILABLE',
    `${workspace} needs the ${pkg} package: install it next to @cogitator-ai/sandbox`,
    { cause: error }
  );
}

/** The error a workspace fails with when it could not create or reach its sandbox. */
export function unreachable(provider: string, error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError(
    'UNAVAILABLE',
    `Could not create or connect to the ${provider} sandbox: ${message(error)}`,
    { cause: error }
  );
}

/** A file operation's failure: `NOT_FOUND` when the provider says the file is missing, `IO` otherwise. */
export function fileError(provider: string, path: string, error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const notFound =
    (error instanceof Error && /not ?found/i.test(error.name)) || statusOf(error) === 404;
  return new WorkspaceError(
    notFound ? 'NOT_FOUND' : 'IO',
    notFound ? `${path} does not exist` : `${provider}: ${path}: ${message(error)}`,
    { path, cause: error }
  );
}

/** A failure to run a program in the sandbox. */
export function commandError(provider: string, error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError('IO', `${provider} could not run the command: ${message(error)}`, {
    cause: error,
  });
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const key of ['statusCode', 'status']) {
    const value: unknown = (error as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  const response: unknown = (error as Record<string, unknown>).response;
  if (typeof response === 'object' && response !== null) {
    const status: unknown = (response as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** A copy of `bytes` as an `ArrayBuffer` of its own. */
export function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
