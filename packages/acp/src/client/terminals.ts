import { RequestError } from '@agentclientprotocol/sdk';
import type {
  CreateTerminalRequest,
  TerminalExitStatus,
  TerminalOutputResponse,
} from '@agentclientprotocol/sdk';
import { WorkspaceError, type Workspace } from '@cogitator-ai/types';

/** Milliseconds a terminal's command may run before it is killed, when nothing else is set */
export const DEFAULT_AGENT_TERMINAL_TIMEOUT = 30 * 60_000;

interface RunningTerminal {
  sessionId: string;
  output: string;
  limit: number | undefined;
  truncated: boolean;
  exit?: TerminalExitStatus;
  done: Promise<TerminalExitStatus>;
  abort: AbortController;
}

/** `text` cut from its start to at most `limit` UTF-8 bytes, at a character boundary */
export function keepLast(text: string, limit: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return { text, cut: false };
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString('utf8'), cut: true };
}

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
};

/**
 * The terminals an external ACP agent runs commands in, served by a `Workspace`: each
 * `terminal/create` starts a command with `exec`, its output kept (the newest `outputByteLimit`
 * bytes) until the agent releases the terminal. A command the agent kills, or one that runs past
 * the timeout, is stopped with its process group
 */
export class AcpTerminals {
  private readonly terminals = new Map<string, RunningTerminal>();
  private next = 0;

  constructor(
    private readonly workspace: Workspace,
    private readonly timeout = DEFAULT_AGENT_TERMINAL_TIMEOUT
  ) {}

  /** Starts `line`, the command line the request names, and returns the terminal's id */
  create(request: CreateTerminalRequest, line: string): string {
    const id = `terminal_${++this.next}`;
    const abort = new AbortController();
    const limit = request.outputByteLimit ?? undefined;
    const terminal: RunningTerminal = {
      sessionId: request.sessionId,
      output: '',
      limit,
      truncated: false,
      done: Promise.resolve({}),
      abort,
    };
    const append = (chunk: string) => {
      terminal.output += chunk;
      if (terminal.limit !== undefined) {
        const kept = keepLast(terminal.output, terminal.limit);
        terminal.output = kept.text;
        if (kept.cut) terminal.truncated = true;
      }
    };
    const cwd = request.cwd ?? undefined;
    terminal.done = this.workspace
      .exec(line, {
        ...(cwd !== undefined && { cwd }),
        env: Object.fromEntries(
          (request.env ?? []).map((variable) => [variable.name, variable.value])
        ),
        signal: abort.signal,
        timeout: this.timeout,
        onStdout: append,
        onStderr: append,
      })
      .then(
        (result): TerminalExitStatus =>
          result.exitCode > 128 && SIGNAL_NAMES[result.exitCode - 128]
            ? { exitCode: null, signal: SIGNAL_NAMES[result.exitCode - 128] }
            : { exitCode: result.exitCode, signal: null },
        (error: unknown): TerminalExitStatus => {
          if (WorkspaceError.is(error, 'ABORTED')) return { exitCode: null, signal: 'SIGTERM' };
          append(`\n${error instanceof Error ? error.message : String(error)}\n`);
          return { exitCode: 127, signal: null };
        }
      )
      .then((status) => {
        terminal.exit = status;
        return status;
      });
    this.terminals.set(id, terminal);
    return id;
  }

  output(sessionId: string, terminalId: string): TerminalOutputResponse {
    const terminal = this.get(sessionId, terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exit && { exitStatus: terminal.exit }),
    };
  }

  waitForExit(sessionId: string, terminalId: string): Promise<TerminalExitStatus> {
    return this.get(sessionId, terminalId).done;
  }

  kill(sessionId: string, terminalId: string): void {
    this.get(sessionId, terminalId).abort.abort();
  }

  release(sessionId: string, terminalId: string): void {
    const terminal = this.get(sessionId, terminalId);
    terminal.abort.abort();
    this.terminals.delete(terminalId);
  }

  /** Stops every command, of `sessionId` or of every session, and forgets their terminals */
  async releaseAll(sessionId?: string): Promise<void> {
    const ending: Promise<unknown>[] = [];
    for (const [id, terminal] of this.terminals) {
      if (sessionId !== undefined && terminal.sessionId !== sessionId) continue;
      terminal.abort.abort();
      ending.push(terminal.done);
      this.terminals.delete(id);
    }
    await Promise.allSettled(ending);
  }

  private get(sessionId: string, terminalId: string): RunningTerminal {
    const terminal = this.terminals.get(terminalId);
    if (terminal?.sessionId !== sessionId) {
      throw RequestError.invalidParams({ terminalId }, `No terminal ${terminalId} in this session`);
    }
    return terminal;
  }
}
