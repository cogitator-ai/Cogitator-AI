/**
 * Accumulates process output up to a byte limit while still consuming the stream.
 */
export class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer | string): void {
    if (this.size >= this.limit) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const remaining = this.limit - this.size;
    const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    this.chunks.push(slice);
    this.size += slice.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }
}
