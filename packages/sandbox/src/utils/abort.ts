/** The error of an execution stopped by its abort signal, with the reason it was given. */
export function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? '' : String(reason);
  return detail ? `Execution aborted: ${detail}` : 'Execution aborted';
}

/**
 * `promise`'s value, or `undefined` as soon as `signal` aborts (an image pull, a container start
 * or a module download can take minutes, and a cancelled execution should not wait for it).
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
