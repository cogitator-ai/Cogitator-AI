import { Worker } from 'node:worker_threads';

/** A line of a file that matched, as the worker reports it. */
export interface LineMatch {
  /** 1-based line number */
  line: number;
  text: string;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', ({ id, text, remaining, maxShown }) => {
  const lines = text.split(/\\r?\\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const hits = [];
  for (let i = 0; i < lines.length && hits.length <= remaining; i++) {
    const line = lines[i];
    if (!regex.test(line)) continue;
    hits.push({ line: i + 1, text: line.length > maxShown ? line.slice(0, maxShown) + '...' : line });
  }
  parentPort.postMessage({ id, hits });
});
`;

export interface RegexWorkerOptions {
  pattern: string;
  flags: string;
  /** Milliseconds one file may take before the worker is stopped */
  timeout: number;
  /** Characters of a matching line that are reported */
  maxShown: number;
}

/**
 * Matches a regular expression against texts in a worker thread, so a pattern that backtracks
 * catastrophically (such as `(a+)+$`) cannot block the event loop: a file that takes longer
 * than `timeout` stops the worker and fails the search.
 */
export class RegexWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private failure?: Error;

  constructor(private readonly options: RegexWorkerOptions) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern: options.pattern, flags: options.flags },
    });
    this.worker.unref();
    this.worker.on('error', (error) => {
      this.failure = error;
    });
  }

  /** The lines of `text` that match, at most `remaining + 1` (one more tells there are more). */
  match(text: string, remaining: number, label: string): Promise<LineMatch[]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<LineMatch[]>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        this.worker.off('error', onError);
        this.worker.off('exit', onExit);
      };
      const onMessage = (message: { id: number; hits: LineMatch[] }) => {
        if (message.id !== id) return;
        done();
        resolve(message.hits);
      };
      const onError = (error: Error) => {
        done();
        reject(error);
      };
      const onExit = () => {
        done();
        reject(this.failure ?? new Error('The search was stopped'));
      };
      const timer = setTimeout(() => {
        this.failure = new Error(
          `The pattern took more than ${this.options.timeout}ms on ${label}, it may backtrack catastrophically: simplify it (avoid nested quantifiers such as (a+)+)`
        );
        void this.worker.terminate();
      }, this.options.timeout);
      this.worker.on('message', onMessage);
      this.worker.on('error', onError);
      this.worker.on('exit', onExit);
      this.worker.postMessage({
        id,
        text,
        remaining,
        maxShown: this.options.maxShown,
      });
    });
  }

  /** Stops the worker, for example when the search is aborted. */
  stop(reason?: Error): void {
    this.failure ??= reason;
    void this.worker.terminate();
  }
}
