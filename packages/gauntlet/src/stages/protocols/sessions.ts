import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createAppServer, type SessionHost } from '@cogitator-ai/app-server';
import {
  AppServerClient,
  AppServerClientError,
  type StreamEvent,
  type Turn,
} from '@cogitator-ai/app-server/client';
import { PACKAGE_DIR } from '../../packages.js';
import type { StageContext } from '../../runner/types.js';
import { until } from '../edges/shared.js';
import { sessionFixtureVariables } from './session-fixtures.js';

export const APP_SERVER = '@cogitator-ai/app-server';
export const ACP = '@cogitator-ai/acp';
export const MEMORY = '@cogitator-ai/memory';

/** `--import` this to run a TypeScript fixture on Node. */
export const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** A fixture under `fixtures/protocols/`. */
export function protocolFixture(name: string): string {
  return join(PACKAGE_DIR, 'fixtures', 'protocols', name);
}

/** The environment a session fixture of `ctx` runs with, its threads in `database`. */
export function fixtureEnv(
  ctx: StageContext,
  database: string,
  secret: string
): Record<string, string> {
  return sessionFixtureVariables({ model: ctx.model, database, secret });
}

/** One message of the wire, in the order it arrived: what it is and the turn it is about. */
export interface WireEntry {
  kind: 'response' | 'notification' | 'request';
  method?: string;
  turnId?: string;
}

function turnIdOf(value: unknown): string | undefined {
  const direct: unknown = Reflect.get(Object(value), 'turnId');
  if (typeof direct === 'string') return direct;
  const nested: unknown = Reflect.get(Object(Reflect.get(Object(value), 'turn')), 'id');
  return typeof nested === 'string' ? nested : undefined;
}

/** Reads a line the server sent into a {@link WireEntry}, none for a line that is not JSON. */
export function wireEntry(line: string): WireEntry | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  const method: unknown = Reflect.get(Object(message), 'method');
  const hasId = Reflect.has(Object(message), 'id');
  if (typeof method === 'string') {
    const turnId = turnIdOf(Reflect.get(Object(message), 'params'));
    return {
      kind: hasId ? 'request' : 'notification',
      method,
      ...(turnId !== undefined && { turnId }),
    };
  }
  const turnId = turnIdOf(Reflect.get(Object(message), 'result'));
  return { kind: 'response', ...(turnId !== undefined && { turnId }) };
}

/** An app-server client and the wire it reads, in arrival order. */
export interface WiredClient {
  client: AppServerClient;
  wire: WireEntry[];
}

/** A session fixture running on Node, its stdin and stdout the client's wire. */
export interface StdioFixture extends WiredClient {
  /** The tail of what the process wrote to stderr. */
  stderr(): string;
  /** Closes the client's end and resolves once the process exited, killing it after `ms`. */
  stop(ms?: number): Promise<number | null>;
}

const STDERR_LIMIT = 6_000;

/** Spawns `fixture` and drives it with the generated client over its stdin and stdout. */
export function spawnAppServerFixture(
  ctx: StageContext,
  fixture: string,
  env: Record<string, string>
): StdioFixture {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, fixture], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const lines = createInterface({ input: child.stdout });
  const wire: WireEntry[] = [];
  const client = new AppServerClient({
    send: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (callback) => {
      lines.on('line', (line) => {
        const entry = wireEntry(line);
        if (entry) wire.push(entry);
        callback(line);
      });
    },
    close: () => {
      child.stdin.end();
    },
  });
  const stop = async (ms = 20_000): Promise<number | null> => {
    client.close();
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    const code = await exited;
    clearTimeout(timer);
    return code;
  };
  ctx.onCleanup(async () => {
    await stop(5_000);
  });
  return { client, wire, stderr: () => stderr, stop };
}

/** The generated client on a connection of `host`'s app-server in this process. */
export function connectInProcess(ctx: StageContext, host: SessionHost): WiredClient {
  const wire: WireEntry[] = [];
  const listeners: Array<(line: string) => void> = [];
  const connection = createAppServer(host).connect((message) => {
    for (const each of Array.isArray(message) ? message : [message]) {
      const line = JSON.stringify(each);
      const entry = wireEntry(line);
      if (entry) wire.push(entry);
      for (const listener of listeners) listener(line);
    }
  });
  const client = new AppServerClient({
    send: (line) => {
      void connection.receive(JSON.parse(line)).catch((error: unknown) => {
        ctx.log(`app-server connection: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onLine: (callback) => {
      listeners.push(callback);
    },
    close: () => {
      void connection.close();
    },
  });
  ctx.onCleanup(() => client.close());
  return { client, wire };
}

/** A tool call of a turn as its events show it. */
export interface ToolCallSeen {
  id: string;
  name: string;
  /** The arguments as streamed, or as a `tool-update` replaced them. */
  args: string;
  result?: unknown;
  /** Whether the result is an `{ error }`. */
  failed: boolean;
}

/** Collects the turn notifications of a client by turn id. */
export class TurnLog {
  private readonly started = new Set<string>();
  private readonly eventsOf = new Map<string, StreamEvent[]>();
  private readonly done = new Map<string, Turn>();

  constructor(
    client: AppServerClient,
    private readonly ctx: StageContext
  ) {
    client.on('turn/started', ({ turn }) => {
      this.started.add(turn.id);
    });
    client.on('turn/event', ({ turnId, event }) => {
      const list = this.eventsOf.get(turnId) ?? [];
      list.push(event);
      this.eventsOf.set(turnId, list);
    });
    client.on('turn/completed', ({ turn }) => {
      this.done.set(turn.id, turn);
      if (turn.usage) {
        ctx.recordUsage(ctx.model, {
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
        });
      }
    });
  }

  events(turnId: string): StreamEvent[] {
    return this.eventsOf.get(turnId) ?? [];
  }

  /** The `turn/completed` of a turn, once it came. */
  async completed(turnId: string, timeoutMs = 120_000): Promise<Turn> {
    await until(
      () => this.done.has(turnId),
      timeoutMs,
      `turn ${turnId} to complete`,
      this.ctx.signal
    );
    return this.done.get(turnId)!;
  }

  /** Waits until a turn sent an event that `match` takes. */
  async event(
    turnId: string,
    match: (event: StreamEvent) => boolean,
    what: string,
    timeoutMs = 90_000
  ): Promise<StreamEvent> {
    await until(
      () => this.events(turnId).some(match) || this.done.has(turnId),
      timeoutMs,
      what,
      this.ctx.signal
    );
    const found = this.events(turnId).find(match);
    if (!found) {
      const turn = this.done.get(turnId);
      throw new Error(
        `The turn ended ${turn?.status ?? 'unknown'} before ${what} (tools: ${this.toolCalls(turnId)
          .map((call) => call.name)
          .join(', ')})`
      );
    }
    return found;
  }

  /** The tool calls a turn's events show, with their results. */
  toolCalls(turnId: string): ToolCallSeen[] {
    const calls = new Map<string, ToolCallSeen>();
    for (const event of this.events(turnId)) {
      if (event.type === 'tool-call-start') {
        calls.set(event.id, { id: event.id, name: event.toolName, args: '', failed: false });
      } else if (event.type === 'tool-call-delta') {
        const call = calls.get(event.id);
        if (call) call.args += event.argsTextDelta;
      } else if (event.type === 'tool-update' && event.arguments) {
        const call = calls.get(event.toolCallId);
        if (call) call.args = JSON.stringify(event.arguments);
      } else if (event.type === 'tool-result') {
        const call = calls.get(event.toolCallId);
        if (call) {
          call.result = event.result;
          call.failed =
            typeof event.result === 'object' && event.result !== null && 'error' in event.result;
        }
      }
    }
    return [...calls.values()];
  }

  /** The streamed text of a turn. */
  text(turnId: string): string {
    return this.events(turnId)
      .map((event) => (event.type === 'text-delta' ? event.delta : ''))
      .join('');
  }
}

/** The text input of a turn. */
export function textInput(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/** The error code a request was refused with, or throws when it was answered. */
export async function refusalCode(request: Promise<unknown>): Promise<number> {
  try {
    await request;
  } catch (error) {
    if (error instanceof AppServerClientError) return error.code;
    throw error;
  }
  throw new Error('The request was answered instead of refused');
}
