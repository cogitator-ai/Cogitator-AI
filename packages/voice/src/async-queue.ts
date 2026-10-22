interface Waiter<T> {
  resolve: (result: IteratorResult<T, undefined>) => void;
  reject: (error: Error) => void;
}

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * An async iterator fed by pushes: values come out in the order they were pushed, none is lost
 * while nobody waits, and `fail` hands its error to the next read once the values before it
 * are read. `return()` (a consumer that stops early) drops what is queued and calls `onReturn`.
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T, undefined> {
  private readonly items: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private ended = false;
  private failure: Error | undefined;

  constructor(private readonly onReturn?: () => void) {}

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(DONE);
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    const waiters = this.waiters.splice(0);
    if (waiters.length === 0) {
      this.failure = error;
      return;
    }
    for (const waiter of waiters) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift() as T });
    }
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      return Promise.reject(failure);
    }
    if (this.ended) return Promise.resolve(DONE);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<T, undefined>> {
    const open = !this.ended;
    this.items.length = 0;
    this.failure = undefined;
    this.end();
    if (open) this.onReturn?.();
    return Promise.resolve(DONE);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}
