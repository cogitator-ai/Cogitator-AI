import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { StreamWriter } from '../streaming/stream-writer.js';
import { generateId } from '../streaming/encoder.js';
import { describeRunError } from './http.js';
import { toPendingApprovals } from './result.js';

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
  /** Starts or resumes the run with the callbacks of the stream */
  start: (callbacks: StreamCallbacks) => Promise<RunResult>;
  afterRun?: (result: RunResult) => Promise<void>;
}

/**
 * Answers with the run streamed in the chat protocol: text and reasoning parts,
 * tool calls and results, `approval-required` when it pauses, then `finish`, or
 * `error` when it fails.
 */
export function streamAgentRun({ req, runContext, start, afterRun }: StreamRunOptions): Response {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const sw = new StreamWriter(writable.getWriter());
  const messageId = generateId('msg');

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
  const emit = (write: () => Promise<void>): Promise<void> => {
    queue = queue.then(write).catch(abortRun);
    return queue;
  };

  let openPart: { kind: 'text' | 'reasoning'; id: string } | null = null;
  let streamedText = false;
  let streamedReasoning = false;

  const endPart = async () => {
    if (openPart === null) return;
    const { kind, id } = openPart;
    openPart = null;
    await (kind === 'text' ? sw.textEnd(id) : sw.reasoningEnd(id));
  };

  const writeText = async (delta: string) => {
    if (openPart?.kind !== 'text') {
      await endPart();
      openPart = { kind: 'text', id: generateId('txt') };
      await sw.textStart(openPart.id);
    }
    await sw.textDelta(openPart.id, delta);
  };

  const writeReasoning = async (delta: string) => {
    if (openPart?.kind !== 'reasoning') {
      await endPart();
      openPart = { kind: 'reasoning', id: generateId('rsn') };
      await sw.reasoningStart(openPart.id);
    }
    await sw.reasoningDelta(openPart.id, delta);
  };

  const runStream = async () => {
    try {
      await emit(() => sw.start(messageId));

      const result = await start({
        stream: true,
        signal: abortController.signal,
        onToken: (token: string) => {
          if (!token) return;
          streamedText = true;
          void emit(() => writeText(token));
        },
        onReasoning: (delta: string) => {
          if (!delta) return;
          streamedReasoning = true;
          void emit(() => writeReasoning(delta));
        },
        onToolCall: (tc) => {
          void emit(async () => {
            await endPart();
            await sw.toolCallStart(tc.id, tc.name);
            await sw.toolCallDelta(tc.id, JSON.stringify(tc.arguments));
            await sw.toolCallEnd(tc.id);
          });
        },
        onToolResult: (tr) => {
          void emit(() => sw.toolResult(generateId('tr'), tr.callId, tr.result));
        },
      });

      await queue;

      const { reasoning } = result;
      if (!streamedReasoning && reasoning) {
        await emit(() => writeReasoning(reasoning));
      }
      if (!streamedText && result.output) {
        await emit(() => writeText(result.output));
      }
      await emit(endPart);

      if (result.status === 'paused') {
        const approvals = toPendingApprovals(result.pendingApprovals ?? []);
        await emit(() => sw.approvalRequired(result.threadId, approvals));
      }

      if (afterRun) {
        await afterRun(result);
      }

      await emit(() => sw.finish(messageId, result.usage, result.threadId));
    } catch (err) {
      await queue;
      if (!sw.isClosed) {
        const { message, code } = describeRunError(err);
        await emit(async () => {
          await endPart();
          await sw.error(message, code);
        });
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
