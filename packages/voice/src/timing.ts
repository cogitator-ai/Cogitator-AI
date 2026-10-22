/** How long voice turns wait for work of the turn before them by default, in ms */
export const DEFAULT_SETTLE_TIMEOUT = 10_000;

/** Resolves once `promise` settles or `ms` pass, whichever comes first */
export function bounded(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}
