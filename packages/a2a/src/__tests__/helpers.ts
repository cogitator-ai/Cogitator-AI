import { randomUUID } from 'node:crypto';
import type { JsonRpcResponse } from '../json-rpc';
import type { A2AMessage, A2AStreamEvent } from '../types';

export function expectResponse(response: JsonRpcResponse | null): JsonRpcResponse {
  if (response === null) {
    throw new Error('Expected a JSON-RPC response, got null');
  }
  return response;
}

/** A user message with one text part, as an A2A v0.3 client sends it. */
export function userMessage(text: string, extra: Partial<A2AMessage> = {}): A2AMessage {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
    ...extra,
  };
}

/** Every JSON-RPC response a stream yields. */
export async function collect(stream: AsyncIterable<JsonRpcResponse>): Promise<JsonRpcResponse[]> {
  const responses: JsonRpcResponse[] = [];
  for await (const response of stream) responses.push(response);
  return responses;
}

/** The events of a stream's successful responses. */
export async function collectEvents(
  stream: AsyncIterable<JsonRpcResponse>
): Promise<A2AStreamEvent[]> {
  const responses = await collect(stream);
  return responses.filter((r) => r.error === undefined).map((r) => r.result as A2AStreamEvent);
}
