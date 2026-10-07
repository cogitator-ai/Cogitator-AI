export { generateId } from '@cogitator-ai/server-shared';

const encoder = new TextEncoder();

export function encodeSSE(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export function encodeDone(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}
