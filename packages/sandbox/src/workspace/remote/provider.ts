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

/**
 * The error a workspace fails with when the provider's SDK cannot be loaded: "install it" when
 * the package itself is missing, the real cause otherwise (a broken install, a Node.js version the
 * SDK does not support).
 */
export function sdkError(workspace: string, pkg: string, error: unknown): WorkspaceError {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const missing =
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    message(error).includes(`'${pkg}'`);
  return new WorkspaceError(
    'UNAVAILABLE',
    missing
      ? `${workspace} needs the ${pkg} package: install it next to @cogitator-ai/sandbox`
      : `${workspace} could not load the ${pkg} package: ${message(error)}`,
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
export function fileError(
  provider: string,
  path: string,
  error: unknown,
  notFound: boolean
): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
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

/** A copy of `bytes` as an `ArrayBuffer` of its own. */
export function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `extend` at most once at a time and only when half of `lifetime` has passed since the
 * last call, so a keepalive asked for before every operation reaches the provider rarely. A
 * failed call (a plan limit, a network error) counts as a call, and each failure in a row doubles
 * the wait, up to the whole lifetime.
 */
export function throttledKeepAlive(
  lifetime: number,
  extend: () => Promise<void>
): () => Promise<void> {
  let last = Date.now();
  let wait = lifetime / 2;
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    if (Date.now() - last < wait) return Promise.resolve();
    pending = extend()
      .then(
        () => {
          wait = lifetime / 2;
        },
        (error: unknown) => {
          wait = Math.min(wait * 2, lifetime);
          throw error;
        }
      )
      .finally(() => {
        last = Date.now();
        pending = undefined;
      });
    return pending;
  };
}
