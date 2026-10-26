export { generateId } from '@cogitator-ai/server-shared';

const encoder = new TextEncoder();

/**
 * One SSE frame of `data` as JSON, with its `id` first when it has one (an event of a
 * resumable stream), which a client sends back as `Last-Event-ID` to resume after it
 */
export function encodeSSE(data: unknown, id?: string): Uint8Array {
  const frame = `data: ${JSON.stringify(data)}\n\n`;
  return encoder.encode(id === undefined ? frame : `id: ${id}\n${frame}`);
}

export function encodeDone(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}
