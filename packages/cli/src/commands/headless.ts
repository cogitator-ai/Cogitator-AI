/**
 * cogitator run -p - one session without a terminal: a prompt in, the answer out as text, JSON
 * or stream-json, with stream-json input for many turns
 */

import type { Agent, Cogitator } from '@cogitator-ai/core';
import {
  JsonRpcCallError,
  encodeNdjsonLine,
  readNdjson,
  type JsonRpcError,
} from '@cogitator-ai/server-shared';
import {
  APP_SERVER_ERROR_CODES,
  SessionHost,
  type TurnInfo,
  type TurnStartParams,
} from '@cogitator-ai/app-server';
import { CommandError, UsageError } from '../utils/cli.js';
import {
  HEADLESS_EXIT,
  exitCodeOfTurn,
  parseInputLine,
  resultLine,
  streamJsonEvent,
  type ClaimedStdout,
  type InputLine,
  type HeadlessPlan,
} from '../utils/headless.js';

/** The name the CLI's agent goes by in its sessions */
export const HEADLESS_AGENT = 'default';

export interface HeadlessIo {
  /** Stdout, held for the answer and the protocol lines */
  stdout: ClaimedStdout;
  stderr: { write(text: string): unknown };
  stdin: AsyncIterable<Uint8Array | string>;
  /** Whether stdin is a terminal, so a prompt is not read from it */
  stdinIsTTY: boolean;
}

export interface HeadlessRun {
  cogitator: Cogitator;
  agent: Agent;
  plan: HeadlessPlan;
  /** The prompt of the command line, for text input */
  message?: string;
  io: HeadlessIo;
  version?: string;
}

type TurnRequest = Omit<TurnStartParams, 'threadId'>;

type UserLine = Extract<InputLine, { type: 'user' }>;

/**
 * Runs one headless session and returns the exit code: 0 when its last turn completed, 1 when it
 * failed or was interrupted, 3 when it was left paused. Only the answer, or protocol lines, reach
 * stdout.
 *
 * @throws CommandError when the session to resume or fork cannot be opened, UsageError for a
 * missing prompt
 */
export async function runHeadless(run: HeadlessRun): Promise<number> {
  const { plan, io } = run;
  const host = new SessionHost({
    cogitator: run.cogitator,
    agents: { [HEADLESS_AGENT]: run.agent },
    exposeErrors: true,
    serverInfo: { name: 'cogitator-cli', version: run.version ?? '0.0.0' },
  });
  const finished = new Map<string, TurnInfo>();
  const waiting = new Map<string, (turn: TurnInfo) => void>();
  let threadId = '';
  host.subscribe((notification) => {
    if (notification.method === 'turn/event') {
      if (plan.outputFormat === 'stream-json' && notification.params.threadId === threadId) {
        void io.stdout.write(encodeNdjsonLine(streamJsonEvent(notification.params)));
      }
      return;
    }
    if (notification.method !== 'turn/completed') return;
    const turn = notification.params.turn;
    const waiter = waiting.get(turn.id);
    if (waiter) {
      waiting.delete(turn.id);
      waiter(turn);
    } else {
      finished.set(turn.id, turn);
    }
  });
  const completion = (turnId: string) =>
    new Promise<TurnInfo>((resolve) => {
      const done = finished.get(turnId);
      if (done) {
        finished.delete(turnId);
        resolve(done);
      } else {
        waiting.set(turnId, resolve);
      }
    });

  const report = async (turn: TurnInfo): Promise<number> => {
    const structuredWanted = plan.outputSchema !== undefined;
    const missing =
      structuredWanted && turn.status === 'completed' && turn.structured === undefined;
    if (plan.outputFormat === 'text') {
      writeText(turn, io, structuredWanted);
    } else {
      await io.stdout.write(encodeNdjsonLine(resultLine(turn, { structuredWanted })));
    }
    return exitCodeOfTurn(turn, missing);
  };

  const startTurn = async (request: TurnRequest): Promise<TurnInfo> =>
    host.startTurn({
      threadId,
      ...request,
      ...(plan.outputSchema !== undefined && { outputSchema: plan.outputSchema }),
    });

  try {
    threadId = await openSession(host, plan);
    if (plan.inputFormat === 'text') {
      const prompt = await promptOf(run.message, io);
      let turn: TurnInfo;
      try {
        turn = await startTurn({ input: [{ type: 'text', text: prompt }] });
      } catch (error) {
        throw asCommandError(error, threadId);
      }
      return await report(await completion(turn.id));
    }
    return await streamSession(host, threadId, io, startTurn, completion, report);
  } finally {
    await host.close();
    await io.stdout.drained();
  }
}

async function openSession(host: SessionHost, plan: HeadlessPlan): Promise<string> {
  try {
    if (plan.resume !== undefined && plan.fork) {
      const fork = await host.forkThread({
        threadId: plan.resume,
        ...(plan.sessionId !== undefined && { newThreadId: plan.sessionId }),
      });
      return fork.id;
    }
    if (plan.resume !== undefined) {
      return (await host.resumeThread(plan.resume)).thread.id;
    }
    return (
      await host.startThread({ ...(plan.sessionId !== undefined && { threadId: plan.sessionId }) })
    ).id;
  } catch (error) {
    if (error instanceof JsonRpcCallError && error.code === APP_SERVER_ERROR_CODES.notFound) {
      throw new CommandError(`Session ${plan.resume} does not exist`, {
        hints: ['Sessions are kept in ~/.cogitator/sessions.db, or COGITATOR_SESSIONS_DB'],
      });
    }
    if (error instanceof JsonRpcCallError && error.code === APP_SERVER_ERROR_CODES.invalidParams) {
      throw new CommandError(error.message, {
        hints: [`Continue it with --resume ${plan.sessionId ?? '<session-id>'}`],
      });
    }
    throw asCommandError(error, plan.resume ?? plan.sessionId ?? '');
  }
}

/**
 * The prompt of a text run: the argument, with what is piped on stdin after it (as
 * `git diff | cogitator run -p "Review this"` sends it), or stdin alone without an argument
 */
async function promptOf(message: string | undefined, io: HeadlessIo): Promise<string> {
  if (io.stdinIsTTY) {
    if (message !== undefined) return message;
    throw new UsageError('-p needs a prompt: pass it as the argument or on stdin', [
      'cogitator run -p "Summarize README.md"',
      'git diff | cogitator run -p "Review this diff"',
    ]);
  }
  const piped = (await readStdin(io)).trim();
  if (message !== undefined) return piped === '' ? message : `${message}\n\n${piped}`;
  if (piped === '') throw new UsageError('-p got an empty prompt on stdin');
  return piped;
}

async function readStdin(io: HeadlessIo): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of io.stdin) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function writeText(turn: TurnInfo, io: HeadlessIo, structuredWanted: boolean): void {
  if (turn.status === 'completed') {
    const answer =
      structuredWanted && turn.structured !== undefined
        ? JSON.stringify(turn.structured)
        : (turn.output ?? '');
    void io.stdout.write(`${answer}\n`);
    if (structuredWanted && turn.structured === undefined) {
      io.stderr.write(`The answer does not match --json-schema: ${turn.structuredError ?? ''}\n`);
    }
    return;
  }
  if (turn.output) void io.stdout.write(`${turn.output}\n`);
  if (turn.status === 'paused') {
    const waits = [
      ...(turn.pending?.approvals ?? []).map(
        (approval) => `approval of ${approval.toolName} (call ${approval.toolCallId})`
      ),
      ...(turn.pending?.interrupts ?? [])
        .filter((entry) => entry.kind !== 'approval')
        .map((entry) => `an answer to "${entry.message}" (interrupt ${entry.id})`),
    ];
    io.stderr.write(
      `Paused: the turn waits on ${waits.join(', ') || 'a decision'}.\n` +
        `Answer it with: cogitator run -p --resume ${turn.threadId} --input-format stream-json --output-format stream-json\n` +
        `and a line such as {"type":"resume","defaultDecision":{"approved":true}}\n`
    );
    return;
  }
  io.stderr.write(`${turn.error?.message ?? `The turn ended ${turn.status}`}\n`);
}

async function streamSession(
  host: SessionHost,
  threadId: string,
  io: HeadlessIo,
  startTurn: (request: TurnRequest) => Promise<TurnInfo>,
  completion: (turnId: string) => Promise<TurnInfo>,
  report: (turn: TurnInfo) => Promise<number>
): Promise<number> {
  const queue: TurnRequest[] = [];
  let active: string | undefined;
  let starting = false;
  let held: Array<{ type: 'interrupt' } | { type: 'user'; line: UserLine }> = [];
  let exitCode: number = HEADLESS_EXIT.ok;
  let pumping: Promise<void> | undefined;

  const interrupt = (turnId: string) => {
    try {
      host.interruptTurn(threadId, turnId);
    } catch {
      io.stderr.write('Nothing to interrupt: the turn had ended\n');
    }
  };
  const steer = (turnId: string, line: UserLine) => {
    try {
      host.steerTurn({
        threadId,
        expectedTurnId: turnId,
        input: line.input,
        delivery: line.delivery ?? 'steer',
      });
    } catch {
      enqueue({ input: line.input });
    }
  };
  /** What came while the turn was starting, applied once it has an id, or without one */
  const release = (turnId: string | undefined) => {
    const lines = held;
    held = [];
    for (const entry of lines) {
      if (entry.type === 'interrupt') {
        if (turnId === undefined) io.stderr.write('Nothing to interrupt: the turn did not start\n');
        else interrupt(turnId);
      } else if (turnId === undefined) {
        enqueue({ input: entry.line.input });
      } else {
        steer(turnId, entry.line);
      }
    }
  };

  const pump = async () => {
    for (let request = queue.shift(); request; request = queue.shift()) {
      starting = true;
      let turn: TurnInfo;
      try {
        turn = await startTurn(request);
      } catch (error) {
        starting = false;
        release(undefined);
        exitCode = HEADLESS_EXIT.failed;
        await io.stdout.write(encodeNdjsonLine(errorResult(threadId, error)));
        continue;
      }
      starting = false;
      active = turn.id;
      release(turn.id);
      const done = await completion(turn.id);
      active = undefined;
      exitCode = await report(done);
    }
  };
  const enqueue = (request: TurnRequest) => {
    queue.push(request);
    pumping ??= pump().finally(() => {
      pumping = undefined;
    });
  };

  for await (const read of readNdjson(io.stdin)) {
    if ('error' in read) {
      io.stderr.write(`Skipped input line ${read.error.line}: ${read.error.message}\n`);
      continue;
    }
    const parsed = parseInputLine(read.value);
    if ('error' in parsed) {
      io.stderr.write(`Skipped an input line. ${parsed.error}\n`);
      continue;
    }
    const line = parsed.line;
    if (line.type === 'resume') {
      const { type: _type, ...resume } = line;
      enqueue({ resume });
      continue;
    }
    if (line.type === 'interrupt') {
      if (starting) held.push({ type: 'interrupt' });
      else if (active !== undefined) interrupt(active);
      else io.stderr.write('Nothing to interrupt: no turn is going on\n');
      continue;
    }
    if (line.delivery === undefined) enqueue({ input: line.input });
    else if (starting) held.push({ type: 'user', line });
    else if (active !== undefined) steer(active, line);
    else enqueue({ input: line.input });
  }
  while (pumping) await pumping;
  return exitCode;
}

function rpcErrorOf(error: unknown): JsonRpcError {
  if (error instanceof JsonRpcCallError) return error.toJSON();
  return {
    code: APP_SERVER_ERROR_CODES.internalError,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** The `result` line of a turn that could not start */
function errorResult(threadId: string, error: unknown): Record<string, unknown> {
  const rpc = rpcErrorOf(error);
  const data = rpc.data;
  const runtimeCode =
    typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string'
      ? data.code
      : undefined;
  return {
    type: 'result',
    subtype: 'error',
    is_error: true,
    session_id: threadId,
    result: '',
    error: { message: rpc.message, code: runtimeCode ?? String(rpc.code) },
  };
}

function asCommandError(error: unknown, threadId: string): CommandError {
  if (error instanceof JsonRpcCallError && error.code === APP_SERVER_ERROR_CODES.threadPaused) {
    return new CommandError(error.message, {
      hints: [
        `cogitator run -p --resume ${threadId} --input-format stream-json --output-format stream-json`,
        'then send {"type":"resume","defaultDecision":{"approved":true}} or decisions by call id',
      ],
    });
  }
  return new CommandError(rpcErrorOf(error).message, { cause: error });
}
