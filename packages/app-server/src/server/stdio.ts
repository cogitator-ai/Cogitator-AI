import { encodeNdjsonLine, readNdjson, type JsonRpcMessage } from '@cogitator-ai/server-shared';
import type { AppServer } from './app-server.js';

/** What `serveStdio` writes to: a stream of the Node shape, as `process.stdout` is */
export interface StdioOutput {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once(event: 'drain', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ServeStdioOptions {
  /** What the client writes, NDJSON: `process.stdin` by default */
  input?: AsyncIterable<Uint8Array | string>;
  /** Where messages go, one JSON per line: `process.stdout` by default */
  output?: StdioOutput;
  /** Hears what went wrong outside a call, such as a write that failed */
  onError?: (error: Error) => void;
  /** The longest line read, in UTF-8 bytes (default 16 MiB), see `readNdjson` */
  maxLineBytes?: number;
}

/**
 * A line writer that keeps the order lines were given in and waits for `drain` whenever the
 * stream asks it to, so a slow reader never makes the process buffer without end
 */
export class OrderedLineWriter {
  private readonly queue: Array<{ line: string; done: () => void; fail: (error: Error) => void }> =
    [];
  private flushing: Promise<void> | undefined;
  private failed: Error | undefined;

  constructor(private readonly output: StdioOutput) {}

  /** Queues `line`, resolving once it is written */
  write(line: string): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    const written = new Promise<void>((done, fail) => this.queue.push({ line, done, fail }));
    this.flushing ??= this.flush();
    return written;
  }

  /** Resolves once every queued line is written */
  async drained(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  private async flush(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        if (this.failed) {
          next.fail(this.failed);
          continue;
        }
        try {
          await this.writeLine(next.line);
          next.done();
        } catch (error) {
          next.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.flushing = undefined;
    }
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.failed = error;
        reject(error);
      };
      this.output.once('error', onError);
      const done = () => {
        this.output.off?.('error', onError);
        resolve();
      };
      if (this.output.write(line)) done();
      else this.output.once('drain', done);
    });
  }
}

/**
 * Serves `server` to one client over stdio: JSON-RPC 2.0 messages as NDJSON, one per line,
 * `jsonrpc` optional on what the client sends. Lines go out in the order they were made,
 * waiting for the output to drain. A line that is not JSON is answered with a parse error. When
 * the input ends the requests still being handled are answered, the turns this client started
 * are interrupted and waited for, every line is written, and the promise resolves.
 */
export async function serveStdio(
  server: AppServer,
  options: ServeStdioOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin;
  const writer = new OrderedLineWriter(options.output ?? process.stdout);
  const report = (error: unknown) =>
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const connection = server.connect((message: JsonRpcMessage | JsonRpcMessage[]) => {
    writer.write(encodeNdjsonLine(message)).catch(report);
  });
  const handling = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    const tracked = work.catch(report).finally(() => handling.delete(tracked));
    handling.add(tracked);
  };
  try {
    for await (const line of readNdjson(input, {
      ...(options.maxLineBytes !== undefined && { maxLineBytes: options.maxLineBytes }),
    })) {
      if ('value' in line) track(connection.receive(line.value));
      else track(connection.receiveUnreadable(`Line ${line.error.line}: ${line.error.message}`));
    }
  } finally {
    await Promise.all([...handling]);
    await connection.close();
    await writer.drained();
  }
}
