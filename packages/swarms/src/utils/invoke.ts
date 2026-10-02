function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function invokeSafely<A extends unknown[]>(
  handler: (...args: A) => unknown,
  args: A,
  label: string
): void {
  try {
    const result = handler(...args);
    if (isPromiseLike(result)) {
      Promise.resolve(result).catch((error: unknown) => {
        console.warn(`${label}:`, error);
      });
    }
  } catch (error) {
    console.warn(`${label}:`, error);
  }
}
