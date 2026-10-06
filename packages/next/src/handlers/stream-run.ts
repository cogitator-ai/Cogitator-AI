import { AgentStreamSession } from '@cogitator-ai/server-shared';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { StreamWriter } from '../streaming/stream-writer.js';
import { describeRunError } from './http.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/** The run options a streamed run or resume is given by the stream. */
export type StreamCallbacks = Required<
  Pick<RunOptions, 'stream' | 'signal' | 'onToken' | 'onReasoning' | 'onToolCall' | 'onToolResult'>
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
}

/**
 * Answers with the run streamed in the chat protocol, the same as every Cogitator adapter:
 * `start` naming the thread, text and reasoning parts, tool calls and results,
 * `approval-required` when it pauses, then `finish` with the thread and how the run ended,
 * or `error` when it fails. Heartbeat comments keep the stream open while the run is silent.
 */
export function streamAgentRun({
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
