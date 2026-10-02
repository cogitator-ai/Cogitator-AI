import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { WebChatChannel } from '../channels/webchat';
import type { ChannelMessage } from '@cogitator-ai/types';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function connect(
  url: string
): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

const channels: WebChatChannel[] = [];
afterEach(async () => {
  for (const ch of channels.splice(0)) await ch.stop();
});

describe('WebChatChannel', () => {
  it('round-trips messages and validates payloads', async () => {
    const port = await freePort();
    const channel = new WebChatChannel({ port });
    channels.push(channel);
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();

    const { ws, messages } = await connect(`ws://127.0.0.1:${port}/ws`);
    await vi.waitFor(() => expect(messages[0]?.type).toBe('connected'));
    const clientId = messages[0].clientId as string;

    ws.send('not json');
    ws.send(JSON.stringify({ text: 42 }));
    ws.send(JSON.stringify({ text: 'hello', id: 'c1' }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg).toEqual(expect.objectContaining({ id: 'c1', text: 'hello', channelId: clientId }));

    const id = await channel.sendText(clientId, 'reply', { replyTo: 'c1' });
    await vi.waitFor(() =>
      expect(messages.at(-1)).toEqual({ type: 'message', id, text: 'reply', replyTo: 'c1' })
    );
    ws.close();
  });

  it('closes unauthorized connections', async () => {
    const port = await freePort();
    const channel = new WebChatChannel({ port, auth: (t) => t === 'good' });
    channels.push(channel);
    await channel.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bad`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(1008);
  });

  it('rejects start() when the port is taken', async () => {
    const port = await freePort();
    const first = new WebChatChannel({ port });
    channels.push(first);
    await first.start();

    const second = new WebChatChannel({ port });
    await expect(second.start()).rejects.toThrow();
  });

  it('stop() disconnects clients and sendText to unknown clients throws', async () => {
    const port = await freePort();
    const channel = new WebChatChannel({ port });
    await channel.start();
    const { ws } = await connect(`ws://127.0.0.1:${port}/ws`);
    const closed = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));

    await channel.stop();
    expect(await closed).toBe(1001);
    await expect(channel.sendText('missing', 'x')).rejects.toThrow('not connected');
  });
});
