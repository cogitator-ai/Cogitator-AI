import type { WebSocketServerMessage } from './types.js';

const OPEN = 1;

/** The close code of a socket whose client does not read what the server sends */
export const SLOW_CLIENT_CLOSE_CODE = 1008;
export const SLOW_CLIENT_CLOSE_REASON = 'The client does not read its messages fast enough';

/** What the outbox needs of a socket: Bun's `ServerWebSocket` */
export interface OutboxSocket {
  readonly readyState: number;
  /** `-1` when the frame was buffered under backpressure, `0` when it was dropped */
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

/**
 * The frames a socket sends, in order, under backpressure.
 *
 * Once Bun reports backpressure, the frames after it wait here until the socket drains. When
 * more than `maxBufferedBytes` wait, or Bun drops a frame, the socket is closed with
 * {@link SLOW_CLIENT_CLOSE_CODE}: a client that does not read loses its connection, never
 * frames in the middle of a run.
 */
export class SocketOutbox {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private congested = false;
  private closed = false;

  constructor(
    private readonly socket: OutboxSocket,
    private readonly maxBufferedBytes: number
  ) {}

  send(message: WebSocketServerMessage): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    const frame = JSON.stringify(message);
    if (this.congested) {
      this.hold(frame);
      return;
    }
    this.write(frame);
  }

  /** Sends what waited, until the socket pushes back again: the `drain` hook of the socket */
  drain(): void {
    if (this.closed) return;
    this.congested = false;
    while (!this.congested && !this.closed) {
      const frame = this.queue.shift();
      if (frame === undefined) return;
      this.queuedBytes -= Buffer.byteLength(frame);
      this.write(frame);
    }
  }

  /** Drops what waits: the socket closed */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private write(frame: string): void {
    const sent = this.socket.send(frame);
    if (sent === -1) this.congested = true;
    else if (sent === 0) this.giveUp();
  }

  private hold(frame: string): void {
    this.queue.push(frame);
    this.queuedBytes += Buffer.byteLength(frame);
    if (this.queuedBytes > this.maxBufferedBytes) this.giveUp();
  }

  private giveUp(): void {
    this.close();
    this.socket.close(SLOW_CLIENT_CLOSE_CODE, SLOW_CLIENT_CLOSE_REASON);
  }
}
