let counter = 0;

export function generateId(prefix: string = 'id'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const count = (counter++).toString(36);
  return `${prefix}_${timestamp}${random}${count}`;
}

/**
 * One SSE frame of `data` as JSON, with its `id` first when it has one (an event of a
 * resumable stream), which a client sends back as `Last-Event-ID` to resume after it
 */
export function encodeSSE(data: unknown, id?: string): string {
  const frame = `data: ${JSON.stringify(data)}\n\n`;
  return id === undefined ? frame : `id: ${id}\n${frame}`;
}

export function encodeDone(): string {
  return 'data: [DONE]\n\n';
}
