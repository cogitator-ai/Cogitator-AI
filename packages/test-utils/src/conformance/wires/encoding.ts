import { crc32 } from 'node:zlib';

/** One server-sent event: `data:` lines, with an `event:` line when `event` is given. */
export function sse(data: unknown, event?: string): string {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${body}\n\n`;
}

/** One line of newline-delimited JSON. */
export function ndjson(data: unknown): string {
  return `${JSON.stringify(data)}\n`;
}

/**
 * One message of the AWS event stream encoding (`application/vnd.amazon.eventstream`), as Bedrock
 * streams `ConverseStream` events: a prelude with the lengths and its CRC32, string headers, the
 * JSON payload, and the CRC32 of the whole message.
 */
export function awsEventStreamMessage(
  headers: Record<string, string>,
  payload: unknown
): Uint8Array {
  const headerBytes = Buffer.concat(
    Object.entries(headers).map(([name, value]) => {
      const nameBytes = Buffer.from(name, 'utf8');
      const valueBytes = Buffer.from(value, 'utf8');
      const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
      let offset = header.writeUInt8(nameBytes.length, 0);
      offset += nameBytes.copy(header, offset);
      offset = header.writeUInt8(7, offset);
      offset = header.writeUInt16BE(valueBytes.length, offset);
      valueBytes.copy(header, offset);
      return header;
    })
  );
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const total = 12 + headerBytes.length + payloadBytes.length + 4;

  const message = Buffer.alloc(total);
  message.writeUInt32BE(total, 0);
  message.writeUInt32BE(headerBytes.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  headerBytes.copy(message, 12);
  payloadBytes.copy(message, 12 + headerBytes.length);
  message.writeUInt32BE(crc32(message.subarray(0, total - 4)), total - 4);
  return new Uint8Array(message);
}
