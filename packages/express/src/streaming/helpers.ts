let counter = 0;

export function generateId(prefix: string = 'id'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const count = (counter++).toString(36);
  return `${prefix}_${timestamp}${random}${count}`;
}

export function encodeSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function encodeDone(): string {
  return 'data: [DONE]\n\n';
}
