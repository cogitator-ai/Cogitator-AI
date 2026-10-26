import {
  AgentStreamSession,
  ResumableStreams,
  authorizeThreadAccess,
  lastEventIdOf,
  type ResumableStreamOptions,
  type StreamCaller,
  type StreamFollower,
} from '@cogitator-ai/server-shared';
import type { ServerContractOptions } from '../types.js';
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
  streams?: ResumableStreams<Request>;
}

/**
 * The resumable streams of a handler. A reconnect and a cancel do not run `beforeRun` (its
 * side effects would repeat, and a cancel has no input), so a handler that identifies callers
 * in `beforeRun` must bind streams to them with `owner`, which reads the request.
 *
 * @throws Error for `resumableStreams` next to `beforeRun` without an `owner`
 */
export function resumableStreamsOf(
  option: boolean | ResumableStreamOptions<Request> | undefined,
  identifiesCallers: boolean
): ResumableStreams<Request> | undefined {
  if (!option) return undefined;
  const options = option === true ? {} : option;
  if (identifiesCallers && !options.owner) {
    throw new Error(
      'resumableStreams needs an owner next to beforeRun: a reconnect does not run beforeRun, so owner(req) must tell the caller of a stream apart, as beforeRun does'
    );
  }
  return new ResumableStreams<Request>({ owner: () => undefined, ...options });
}

/** The caller of a reconnect or cancel: the request, and `authorizeThread` for the stream's thread */
function callerOf(
  req: Request,
  contract: ServerContractOptions | undefined
): StreamCaller<Request> {
  const authorize = contract?.authorizeThread;
  return {
    auth: req,
    authorizeThread: (threadId) =>
      authorizeThreadAccess(
        authorize && ((_req: Request | undefined, id: string) => authorize(req, id)),
        req,
        threadId
      ),
  };
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
    const opened = await streams.startAgentRun({
      auth: req,
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
    return opened.ok ? followStream(req, opened.stream, heartbeatMs) : errorResponse(opened.error);
  } catch (err) {
    return runErrorResponse(err);
  }
}

/**
 * Answers the requests of a handler with resumable streams that start no run: `DELETE` with
 * `?streamId=` cancels the run of a stream, a request with `Last-Event-ID` or `?lastEventId=`
 * reconnects to its stream. `undefined` for any other request. Neither reads the body nor runs
 * `beforeRun` or `deps`: `owner` identifies the caller, and `authorizeThread` checks the
 * stream's thread.
 */
export async function answerStreamRequest(
  req: Request,
  streams: ResumableStreams<Request>,
  contract: ServerContractOptions | undefined,
  heartbeatMs: number | undefined
): Promise<Response | undefined> {
  const query = new URL(req.url).searchParams;
  try {
    if (req.method === 'DELETE') {
      const cancelled = await streams.cancel(query.get('streamId') ?? '', callerOf(req, contract));
      return cancelled.ok ? new Response(null, { status: 204 }) : errorResponse(cancelled.error);
    }
    const lastEventId = lastEventIdOf(
      req.headers.get('last-event-id'),
      query.getAll('lastEventId')
    );
    if (lastEventId === undefined) return undefined;
    const attached = await streams.reconnect(lastEventId, callerOf(req, contract));
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
