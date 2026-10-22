import { describe, expect, test } from 'bun:test';
import {
  SLOW_CLIENT_CLOSE_CODE,
  SLOW_CLIENT_CLOSE_REASON,
  SocketOutbox,
  type OutboxSocket,
} from '../socket-outbox.js';

/** A socket that pushes back once `room` frames were written, until it is drained */
function slowSocket(room: number) {
  const written: string[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  let free = room;
  let dropping = false;
  const socket: OutboxSocket & {
    readyState: number;
    written: string[];
    closes: typeof closes;
    makeRoom(frames: number): void;
    drop(): void;
  } = {
    readyState: 1,
    written,
    closes,
    send(data) {
      if (dropping) return 0;
      written.push(data);
      free -= 1;
      return free < 0 ? -1 : data.length;
    },
    close(code, reason) {
      closes.push({ code, reason });
      socket.readyState = 3;
    },
    makeRoom(frames) {
      free = frames;
    },
    drop() {
      dropping = true;
    },
  };
  return socket;
}

const frame = (n: number) => ({ type: 'event' as const, id: 'r', payload: { n } });
const numbers = (frames: string[]) =>
  frames.map((data) => (JSON.parse(data) as { payload: { n: number } }).payload.n);

describe('SocketOutbox', () => {
  test('writes frames straight through while the socket keeps up', () => {
    const socket = slowSocket(10);
    const outbox = new SocketOutbox(socket, 1024);
    for (let n = 0; n < 3; n++) outbox.send(frame(n));
    expect(numbers(socket.written)).toEqual([0, 1, 2]);
  });

  test('holds the frames after backpressure and sends them in order once drained', () => {
    const socket = slowSocket(1);
    const outbox = new SocketOutbox(socket, 4096);

    for (let n = 0; n < 5; n++) outbox.send(frame(n));
    expect(numbers(socket.written)).toEqual([0, 1]);

    socket.makeRoom(1);
    outbox.drain();
    expect(numbers(socket.written)).toEqual([0, 1, 2, 3]);

    socket.makeRoom(10);
    outbox.drain();
    expect(numbers(socket.written)).toEqual([0, 1, 2, 3, 4]);
    expect(socket.closes).toEqual([]);

    outbox.send(frame(5));
    expect(numbers(socket.written)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('closes the socket of a client that lets more than maxBufferedBytes wait', () => {
    const socket = slowSocket(0);
    const size = Buffer.byteLength(JSON.stringify(frame(1)));
    const outbox = new SocketOutbox(socket, size * 2);

    for (let n = 0; n < 4; n++) outbox.send(frame(n));

    expect(socket.closes).toEqual([
      { code: SLOW_CLIENT_CLOSE_CODE, reason: SLOW_CLIENT_CLOSE_REASON },
    ]);
    outbox.drain();
    expect(numbers(socket.written)).toEqual([0]);
  });

  test('closes only once more than maxBufferedBytes wait, not at the limit itself', () => {
    const socket = slowSocket(0);
    const size = Buffer.byteLength(JSON.stringify(frame(1)));
    const outbox = new SocketOutbox(socket, size * 2);

    for (let n = 0; n < 3; n++) outbox.send(frame(n));
    expect(socket.closes).toEqual([]);

    outbox.send(frame(3));
    expect(socket.closes).toHaveLength(1);
  });

  test('counts only what still waits, so a long socket that drains now and then stays open', () => {
    const socket = slowSocket(0);
    const size = Buffer.byteLength(JSON.stringify(frame(1)));
    const outbox = new SocketOutbox(socket, size * 2);

    for (let round = 0; round < 20; round++) {
      for (let n = 0; n < 3; n++) outbox.send(frame(round % 10));
      socket.makeRoom(2);
      outbox.drain();
      socket.makeRoom(0);
    }

    expect(socket.closes).toEqual([]);
    expect(socket.written.length).toBeGreaterThan(40);
  });

  test('closes the socket when Bun drops a frame instead of losing it in silence', () => {
    const socket = slowSocket(10);
    const outbox = new SocketOutbox(socket, 4096);
    socket.drop();

    outbox.send(frame(0));
    outbox.send(frame(1));

    expect(socket.closes).toEqual([
      { code: SLOW_CLIENT_CLOSE_CODE, reason: SLOW_CLIENT_CLOSE_REASON },
    ]);
  });

  test('sends nothing once closed or once the socket is no longer open', () => {
    const socket = slowSocket(0);
    const outbox = new SocketOutbox(socket, 4096);
    outbox.send(frame(0));
    outbox.send(frame(1));

    outbox.close();
    socket.makeRoom(10);
    outbox.drain();
    outbox.send(frame(2));
    expect(numbers(socket.written)).toEqual([0]);

    const closing = slowSocket(10);
    closing.readyState = 2;
    new SocketOutbox(closing, 4096).send(frame(0));
    expect(closing.written).toEqual([]);
  });
});
