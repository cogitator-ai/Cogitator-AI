export type SettledOutcome<R> = PromiseSettledResult<R> | undefined;

/**
 * Run `task` for every item with at most `concurrency` tasks in flight.
 * Results keep the input order. With `stopOnFailure`, no new tasks start after the first
 * rejection; items that never started are reported as `undefined`.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
  options: { stopOnFailure?: boolean } = {}
): Promise<SettledOutcome<R>[]> {
  const outcomes: SettledOutcome<R>[] = new Array<SettledOutcome<R>>(items.length).fill(undefined);
  let nextIndex = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      if (failed && options.stopOnFailure) return;
      const index = nextIndex++;
      try {
        outcomes[index] = { status: 'fulfilled', value: await task(items[index], index) };
      } catch (reason) {
        failed = true;
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  };

  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return outcomes;
}
