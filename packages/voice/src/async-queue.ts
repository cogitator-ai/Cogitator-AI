interface Waiter<T, TReturn> {
  resolve: (result: IteratorResult<T, TReturn | undefined>) => void;
  reject: (error: Error) => void;
}

/**
 * An async iterator fed by pushes: values come out in the order they were pushed, none is lost
 * while nobody waits, `end(value)` finishes it with `value` as the iterator's return value, and
 * `fail` hands its error to the next read once the values before it are read. `return()` (a
 * consumer that stops early) drops what is queued and calls `onReturn`.
 */
export class AsyncQueue<T, TReturn = undefined> implements AsyncIterableIterator<
  T,
  TReturn | undefined,
  undefined
> {
  private readonly items: T[] = [];
  private readonly waiters: Waiter<T, TReturn>[] = [];
  private closed = false;
  private failure: Error | undefined;
  private returnValue: TReturn | undefined;

  constructor(private readonly onReturn?: () => void) {}

  /** Whether `end`, `fail` or `return` closed the queue: later pushes are dropped */
  get ended(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.items.push(item);
  }

  end(value?: TReturn): void {
    if (this.closed) return;
    this.closed = true;
    this.returnValue = value;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(this.done());
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    if (waiters.length === 0) {
      this.failure = error;
      return;
    }
    for (const waiter of waiters) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T, TReturn | undefined>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift() as T });
    }
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      return Promise.reject(failure);
    }
    if (this.closed) return Promise.resolve(this.done());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<T, TReturn | undefined>> {
    const open = !this.closed;
    this.items.length = 0;
    this.failure = undefined;
    this.end();
    if (open) this.onReturn?.();
    return Promise.resolve(this.done());
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  private done(): IteratorReturnResult<TReturn | undefined> {
    return { done: true, value: this.returnValue };
  }
}
