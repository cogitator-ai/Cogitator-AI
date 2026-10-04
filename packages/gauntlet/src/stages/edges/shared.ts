import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stripVTControlCharacters } from 'node:util';
import type { StageContext } from '../../runner/types.js';

const OUTPUT_LIMIT = 256 * 1024;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Strips ANSI colour codes so CLI output can be matched as plain text. */
export function plain(text: string): string {
  return stripVTControlCharacters(text);
}

/** A short, single-line excerpt for evidence. */
export function excerpt(text: string, length = 160): string {
  const flat = plain(text).replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}...` : flat;
}

/**
 * Runs a command without a shell and captures its output. Resolves on exit whatever the
 * exit code, rejects only when the process cannot be started or runs past its timeout.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) =>
      current.length >= OUTPUT_LIMIT ? current : current + chunk.toString('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const kill = (reason: Error) => {
      child.kill('SIGKILL');
      reject(reason);
    };
    const timer = setTimeout(
      () => kill(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs} ms`)),
      options.timeoutMs ?? 60_000
    );
    const onAbort = () => kill(new Error(`${command} was aborted`));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void;

/** Starts a plain HTTP server on a free port, closed when the gauntlet ends. */
export async function serveHttp(
  ctx: StageContext,
  handler: RouteHandler
): Promise<{ server: Server; port: number; url: string }> {
  const port = await ctx.freePort();
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  ctx.onCleanup(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/** A parsed JSON text frame, or a binary frame with its size. */
export type Frame =
  { kind: 'json'; data: Record<string, unknown> } | { kind: 'binary'; bytes: number };

/**
 * A WebSocket client on Node's built-in `WebSocket` that keeps every frame it receives,
 * so a check can wait for the frame it needs and then look at everything that came before.
 */
export class FrameClient {
  readonly frames: Frame[] = [];
  closeCode?: number;
  private readonly waiters = new Set<() => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'string') {
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            this.frames.push({ kind: 'json', data: parsed as Record<string, unknown> });
          }
        } catch {
          this.frames.push({ kind: 'json', data: { unparsed: data } });
        }
      } else if (data instanceof ArrayBuffer) {
        this.frames.push({ kind: 'binary', bytes: data.byteLength });
      }
      this.notify();
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      this.closeCode = event.code;
      this.notify();
    });
  }

  /** Opens a connection; resolves once it is open, or once the server closes it right away. */
  static connect(url: string, timeoutMs = 10_000): Promise<FrameClient> {
    const socket = new WebSocket(url);
    const client = new FrameClient(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket ${url} did not open`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(client);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        if (client.closeCode !== undefined) resolve(client);
        else reject(new Error(`WebSocket ${url} failed to connect`));
      });
    });
  }

  get json(): Array<Record<string, unknown>> {
    return this.frames.flatMap((frame) => (frame.kind === 'json' ? [frame.data] : []));
  }

  sendJson(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload));
  }

  sendBinary(chunk: Uint8Array<ArrayBuffer>): void {
    this.socket.send(chunk);
  }

  /** Resolves when `predicate` holds over the frames received so far. */
  waitFor(
    predicate: (client: FrameClient) => boolean,
    timeoutMs: number,
    what: string
  ): Promise<void> {
    if (predicate(this)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      this.waiters.add(check);
    });
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, 'done');
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** Polls `predicate` until it holds; for state that changes without an event to wait on. */
export async function until(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (signal?.aborted) throw new Error(`Aborted while waiting for ${what}`);
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
