import { afterEach, describe, expect, test } from 'bun:test';
import { connect as tcp, type Socket } from 'node:net';
import { createApp } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';
import { SLOW_CLIENT_CLOSE_CODE } from '../socket-outbox.js';
import { chatAgent, fakeCogitator, runResult } from './helpers.js';

const TOKEN = 'x'.repeat(64 * 1024);
const clients: Socket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** A WebSocket client on a raw TCP socket, so the test decides when it reads */
async function rawClient(baseUrl: URL) {
  const client = tcp(Number(baseUrl.port), baseUrl.hostname);
  clients.push(client);
  await new Promise((resolve) => client.once('connect', resolve));
  client.write(
    [
      'GET /ws HTTP/1.1',
      `Host: ${baseUrl.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n')
  );

  let pending = Buffer.alloc(0);
  let upgraded = false;
  const texts: string[] = [];
  let closeCode: number | undefined;
  client.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (!upgraded) {
      const end = pending.indexOf('\r\n\r\n');
      if (end === -1) return;
      upgraded = true;
      pending = pending.subarray(end + 4);
    }
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0]! & 0x0f;
      let length = pending[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (pending.length < offset + length) return;
      const payload = pending.subarray(offset, offset + length);
      pending = pending.subarray(offset + length);
      if (opcode === 0x1) texts.push(payload.toString('utf-8'));
      if (opcode === 0x8) closeCode = payload.readUInt16BE(0);
    }
  });

  const send = (message: unknown) => {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = Buffer.from([1, 2, 3, 4]);
    const header =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    client.write(
      Buffer.concat([header, mask, Buffer.from(payload.map((byte, at) => byte ^ mask[at % 4]!))])
    );
  };

  return { client, send, texts, closeCode: () => closeCode };
}

function serveSockets(deps: Omit<CogitatorDeps, 'websocket'>, maxBufferedBytes: number) {
  return serve(
    createApp({
      routes: cogitatorController({ ...deps, websocket: { maxBufferedBytes } }),
      reportError: () => undefined,
    })
  );
}

async function until(condition: () => boolean, ms = 10_000): Promise<boolean> {
  for (let waited = 0; waited < ms && !condition(); waited += 10) await Bun.sleep(10);
  return condition();
}

describe('websocket backpressure', () => {
  test('closes the socket of a client that stops reading and cancels its run', async () => {
    let signal: AbortSignal | undefined;
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          const pump = () => {
            if (options.signal?.aborted) return;
            for (let i = 0; i < 16; i++) options.onToken?.(TOKEN);
            setTimeout(pump, 1);
          };
          pump();
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } }, 1024 * 1024);
    const connection = await rawClient(new URL(request.url));
    await until(() => connection.client.bytesRead > 0);
    connection.client.pause();

    connection.send({
      type: 'run',
      id: 'r',
      payload: { type: 'agent', name: 'chat', input: 'go' },
    });

    expect(await until(() => signal?.aborted === true)).toBe(true);
    connection.client.resume();
    expect(await until(() => connection.closeCode() !== undefined)).toBe(true);
    expect(connection.closeCode()).toBe(SLOW_CLIENT_CLOSE_CODE);
  }, 20_000);

  test('sends every frame in order to a client that reads late, once the socket drains', async () => {
    const tokens = 160;
    const { cogitator } = fakeCogitator(async (_agent, options) => {
      for (let n = 0; n < tokens; n++) options.onToken?.(`${n}:${TOKEN}`);
      return runResult({ output: 'all sent' });
    });
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } }, 64 * 1024 * 1024);
    const connection = await rawClient(new URL(request.url));
    await until(() => connection.client.bytesRead > 0);
    connection.client.pause();

    connection.send({
      type: 'run',
      id: 'r',
      payload: { type: 'agent', name: 'chat', input: 'go' },
    });
    await Bun.sleep(300);
    connection.client.resume();

    expect(await until(() => connection.texts.some((text) => text.includes('"complete"')))).toBe(
      true
    );
    const frames = connection.texts.map(
      (text) => JSON.parse(text) as { payload: { type: string; delta?: string } }
    );
    const order = frames
      .filter((frame) => frame.payload.type === 'token')
      .map((frame) => Number(frame.payload.delta?.split(':')[0]));
    expect(order).toEqual(Array.from({ length: tokens }, (_, n) => n));
    expect(frames.at(-1)?.payload.type).toBe('complete');
    expect(connection.closeCode()).toBeUndefined();
  }, 20_000);
});
