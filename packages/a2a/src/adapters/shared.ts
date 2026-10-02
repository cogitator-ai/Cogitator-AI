import type { A2AServer } from '../server.js';
import type { A2AStreamEvent } from '../types.js';
import { buildSseErrorEvent } from './sse-error-event.js';

export type HeaderValue = string | string[] | null | undefined;

/**
 * A request streams only for the `message/stream` method; the Accept header
 * alone does not switch a `message/send` request to SSE.
 */
export function isStreamRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).method === 'message/stream'
  );
}

export function firstHeader(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function sseFrame(data: A2AStreamEvent | '[DONE]'): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Drive a JSON-RPC stream and write SSE frames until it ends, the client
 * disconnects (signal aborted) or a write fails. Errors are reported as a
 * final failed status-update frame.
 */
export async function pipeJsonRpcStream(
  server: A2AServer,
  body: unknown,
  authToken: string | undefined,
  signal: AbortSignal,
  write: (frame: string) => void | Promise<void>
): Promise<void> {
  try {
    for await (const event of server.handleJsonRpcStream(body, authToken, signal)) {
      if (signal.aborted) return;
      await write(sseFrame(event));
    }
    if (!signal.aborted) await write(sseFrame('[DONE]'));
  } catch (error) {
    if (signal.aborted) return;
    try {
      await write(sseFrame(buildSseErrorEvent(error)));
    } catch {
      return;
    }
  }
}
