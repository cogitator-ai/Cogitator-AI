import {
  AgentStreamSession,
  lastEventIdOf,
  type ResumableStreams,
  type StreamFollower,
} from '@cogitator-ai/server-shared';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { StreamWriter } from '../streaming/stream-writer.js';
import { describeRunError, errorResponse, runErrorResponse } from './http.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/** The run options a streamed run or resume is given by the stream. */
export type StreamCallbacks = Required<
  Pick<
    RunOptions,
    | 'stream'
    | 'signal'
    | 'onToken'
    | 'onReasoning'
    | 'onToolCall'
    | 'onToolResult'
    | 'onToolUpdate'
    | 'onToolInputStart'
    | 'onToolInputDelta'
    | 'onToolInputAvailable'
    | 'onToolInputAbandoned'
  >
>;

export interface StreamRunOptions {
  req: Request;
  /** What `beforeRun` returned; an `AbortSignal` under `signal` also aborts the run */
  runContext: Record<string, unknown>;
  /** The thread the request named; without one the stream opens a new thread */
  threadId?: string;
  /** Starts or resumes the run on `threadId` with the callbacks of the stream */
  start: (callbacks: StreamCallbacks, threadId: string) => Promise<RunResult>;
  afterRun?: (result: RunResult) => Promise<void>;
  /** How often a heartbeat comment is written while the stream is open; `0` turns it off */
  heartbeatMs?: number;
  /** The handler's resumable streams, when `resumableStreams` is on */
  streams?: ResumableStreams;
}

/** The user `beforeRun` named, who alone may reconnect to the run's stream */
function userIdOf(runContext: Record<string, unknown>): string | undefined {
  return typeof runContext.userId === 'string' ? runContext.userId : undefined;
}

/**
 * Answers with the run streamed in the chat protocol, the same as every Cogitator adapter:
 * `start` naming the thread, text and reasoning parts, tool calls and results,
 * `approval-required` when it pauses for approvals or `interrupt-required` when it pauses for
 * questions its tools asked, then `finish` with the thread and how the run ended,
 * or `error` when it fails. Heartbeat comments keep the stream open while the run is silent.
 * On a resumable stream every event carries its id and the run outlives the request.
 */
export async function streamAgentRun(options: StreamRunOptions): Promise<Response> {
  return options.streams ? resumableAgentRun(options, options.streams) : streamBoundRun(options);
}

/**
 * The run on a resumable stream: it outlives the request, which follows it like any client
 * that reconnects. `afterRun` runs before `finish`, as without resumable streams, and the
 * `signal` of `beforeRun` still stops the run.
 */
async function resumableAgentRun(
  { req, runContext, threadId, start, afterRun, heartbeatMs }: StreamRunOptions,
  streams: ResumableStreams
): Promise<Response> {
  try {
    const stream = await streams.startAgentRun({
      userId: userIdOf(runContext),
      threadId,
      ...(runContext.signal instanceof AbortSignal && { signal: runContext.signal }),
      execute: async (session, signal) => {
        const result = await start(
          { stream: true, signal, ...session.callbacks },
          session.threadId
        );
        if (afterRun) await afterRun(result);
        return result;
      },
      describeError: describeRunError,
    });
    return followStream(req, stream, heartbeatMs);
  } catch (err) {
    return runErrorResponse(err);
  }
}

/**
 * Answers a request that reconnects to a resumable stream with `Last-Event-ID` or
 * `?lastEventId=`: the rest of the stream, or the refusal. `undefined` for a request that names
 * no event. The caller is the user `beforeRun` named for it.
 */
export async function reconnectStream(
  req: Request,
  streams: ResumableStreams,
  runContext: Record<string, unknown>,
  heartbeatMs: number | undefined
): Promise<Response | undefined> {
  const lastEventId = lastEventIdOf(
    req.headers.get('last-event-id'),
    new URL(req.url).searchParams.getAll('lastEventId')
  );
  if (lastEventId === undefined) return undefined;
  try {
    const attached = await streams.reconnect(lastEventId, userIdOf(runContext));
    return attached.ok
      ? followStream(req, attached.stream, heartbeatMs)
      : errorResponse(attached.error);
  } catch (err) {
    return runErrorResponse(err);
  }
}

/** Writes the frames of a resumable stream to one client, until it ends or the client leaves */
function followStream(
  req: Request,
  stream: StreamFollower,
  heartbeatMs: number | undefined
): Response {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const sw = new StreamWriter(writable.getWriter(), { heartbeatMs });
  const client = new AbortController();
  const leave = () => client.abort();
  if (req.signal.aborted) leave();
  else req.signal.addEventListener('abort', leave, { once: true });

  const follow = async () => {
    try {
      for await (const frame of stream.frames(client.signal)) {
        await sw.send(frame.event, frame.id);
      }
    } catch {
      client.abort();
    } finally {
      req.signal.removeEventListener('abort', leave);
      await sw.close();
    }
  };

  void follow();

  return new Response(readable, { headers: SSE_HEADERS });
}

/** The run bound to its request: a client that leaves stops it */
function streamBoundRun({
  req,
  runContext,
  threadId,
  start,
  afterRun,
  heartbeatMs,
}: StreamRunOptions): Response {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const sw = new StreamWriter(writable.getWriter(), { heartbeatMs });

  const abortController = new AbortController();
  const abortRun = () => {
    if (!abortController.signal.aborted) abortController.abort();
  };
  /**
   * Read from `req` on every use: a Request's signal follows its source only
   * while the Request is reachable, so the stream must keep `req` alive.
   */
  const parentSignals = () =>
    [req.signal, runContext.signal].filter(
      (signal): signal is AbortSignal => signal instanceof AbortSignal
    );
  for (const signal of parentSignals()) {
    if (signal.aborted) abortRun();
    else signal.addEventListener('abort', abortRun, { once: true });
  }

  let queue: Promise<void> = Promise.resolve();
  const session = new AgentStreamSession(
    (event) => {
      queue = queue.then(() => sw.send(event)).catch(abortRun);
    },
    { threadId }
  );

  const runStream = async () => {
    try {
      session.start();
      const result = await start(
        { stream: true, signal: abortController.signal, ...session.callbacks },
        session.threadId
      );
      await queue;
      if (afterRun) await afterRun(result);
      session.complete(result);
      await queue;
    } catch (err) {
      await queue;
      if (!sw.isClosed) {
        const { message, code } = describeRunError(err);
        session.fail(message, code);
        await queue;
      }
    } finally {
      for (const signal of parentSignals()) {
        signal.removeEventListener('abort', abortRun);
      }
      await sw.close();
    }
  };

  void runStream().catch(() => {});

  return new Response(readable, { headers: SSE_HEADERS });
}
