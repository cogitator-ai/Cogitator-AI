import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import type { ChannelMessage } from '@cogitator-ai/types';
import { ThreadsChannel, verifyThreadsSignature } from '../channels/threads/channel';

const SECRET = 'app-secret';
const later = () => new Date(Date.now() + 60_000).toISOString();

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
}

function graph(
  data: { mentions?: unknown[]; own?: unknown[]; conversations?: Record<string, unknown[]> } = {}
) {
  const calls: Call[] = [];
  let containers = 0;
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const params = Object.fromEntries(
      method === 'POST' ? new URLSearchParams(String(init?.body)) : url.searchParams
    );
    const path = url.pathname.replace('/v1.0/', '');
    calls.push({ method, path, params });
    const json = (body: unknown) => Response.json(body);
    if (path === 'me' && params.fields === 'id,username')
      return json({ id: '1', username: 'newsroom' });
    if (path === 'me/mentions') return json({ data: data.mentions ?? [] });
    if (path === 'me/threads' && method === 'GET') return json({ data: data.own ?? [] });
    if (path.endsWith('/conversation'))
      return json({ data: data.conversations?.[path.split('/')[0]] ?? [] });
    if (path === 'me/threads_publishing_limit')
      return json({
        data: [
          {
            quota_usage: 0,
            config: { quota_total: 250 },
            reply_quota_usage: 0,
            reply_config: { quota_total: 1000 },
          },
        ],
      });
    if (path === 'me/threads') return json({ id: `container-${++containers}` });
    if (path === 'me/threads_publish') return json({ id: `media-${containers}` });
    if (params.fields === 'status,error_message') return json({ status: 'FINISHED' });
    if (params.fields === 'permalink') return json({ permalink: `https://threads.net/${path}` });
    return json({ id: path });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

const channels: ThreadsChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop();
});

async function started(api: ReturnType<typeof graph>, webhook?: { port?: number }) {
  const channel = new ThreadsChannel({
    accessToken: 'token',
    accessTokenExpiresAt: Date.now() + 50 * 24 * 60 * 60 * 1000,
    fetch: api.fetch,
    ...(webhook && { webhook: { appSecret: SECRET, verifyToken: 'verify-me', ...webhook } }),
  });
  channels.push(channel);
  const received: ChannelMessage[] = [];
  channel.onMessage(async (msg) => void received.push(msg));
  await channel.start();
  return { channel, received };
}

function signed(payload: unknown) {
  const rawBody = JSON.stringify(payload);
  return {
    method: 'POST',
    query: {},
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    },
    rawBody,
  };
}

const reply = (
  id: string,
  text: string,
  username = 'reader',
  extra: Record<string, unknown> = {}
) => ({
  id,
  username,
  text,
  media_type: 'TEXT_POST',
  timestamp: later(),
  replied_to: { id: 'root-post' },
  root_post: { id: 'root-post', owner_id: '1', username: 'newsroom' },
  ...extra,
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('ThreadsChannel webhooks', () => {
  it('answers the verification Meta sends for the callback URL', async () => {
    const { channel } = await started(graph(), {});
    expect(
      await channel.handleWebhook({
        method: 'GET',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'verify-me',
          'hub.challenge': '12345',
        },
        headers: {},
      })
    ).toEqual({ status: 200, body: '12345' });
    expect(
      (
        await channel.handleWebhook({
          method: 'GET',
          query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
          headers: {},
        })
      ).status
    ).toBe(403);
  });

  it('delivers signed replies and mentions, in either payload shape, once each', async () => {
    const { channel, received } = await started(graph(), {});
    const threadsShape = {
      app_id: '1',
      topic: 'moderate',
      values: { value: reply('r1', '@newsroom is this true?'), field: 'replies' },
    };
    expect(await channel.handleWebhook(signed(threadsShape))).toEqual({ status: 200, body: 'OK' });
    const metaShape = {
      entry: [
        {
          changes: [
            {
              field: 'mentions',
              value: reply('m1', 'hey @newsroom', 'fan', { replied_to: undefined }),
            },
          ],
        },
      ],
    };
    await channel.handleWebhook(signed(metaShape));
    await channel.handleWebhook(signed(threadsShape));
    await settle();
    expect(received.map((m) => [m.id, m.text, m.userId])).toEqual([
      ['r1', 'is this true?', 'reader'],
      ['m1', 'hey @newsroom', 'fan'],
    ]);
    expect(received[0]).toMatchObject({
      channelType: 'threads',
      channelId: 'post:r1',
      groupId: 'thread:root-post',
      replyTo: 'root-post',
    });
  });

  it('refuses deliveries that are not signed with the app secret, and skips its own posts', async () => {
    const { channel, received } = await started(graph(), {});
    const forged = {
      ...signed({ values: { value: reply('x', 'forged') } }),
      headers: { 'x-hub-signature-256': 'sha256=00' },
    };
    expect((await channel.handleWebhook(forged)).status).toBe(401);
    await channel.handleWebhook(signed({ values: { value: reply('own', 'mine', 'newsroom') } }));
    await settle();
    expect(received).toEqual([]);
    expect(verifyThreadsSignature('body', undefined, SECRET)).toBe(false);
  });

  it('runs its own webhook server when given a port', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
      });
    });
    const { received } = await started(graph(), { port });
    const base = `http://127.0.0.1:${port}/threads/webhook`;
    const verify = await fetch(
      `${base}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc`
    );
    expect(await verify.text()).toBe('abc');
    const delivery = signed({ values: { value: reply('w1', 'over HTTP') } });
    const posted = await fetch(base, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.rawBody,
    });
    expect(posted.status).toBe(200);
    await settle();
    expect(received.map((m) => m.text)).toEqual(['over HTTP']);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
  });
});

describe('ThreadsChannel without webhooks', () => {
  it('polls mentions and replies under its latest posts, newer than its start', async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const api = graph({
      mentions: [
        reply('m1', 'mention me'),
        reply('m-old', 'too old', 'reader', { timestamp: old }),
      ],
      own: [{ id: 'post-1' }],
      conversations: {
        'post-1': [reply('c1', 'a reply'), reply('c-own', 'my own reply', 'newsroom')],
      },
    });
    const { channel, received } = await started(api);
    await channel.poll();
    await channel.poll();
    expect(received.map((m) => m.id).sort()).toEqual(['c1', 'm1']);
    expect(api.calls.find((c) => c.path === 'me/mentions')?.params.fields).toContain('replied_to');
  });

  it('answers under a post as a chain of replies within 500, and posts to its feed', async () => {
    const api = graph();
    const { channel } = await started(api);
    const answer = Array.from({ length: 30 }, (_, i) => `Point ${i} of the answer.`).join(' ');
    const first = await channel.sendText('post:17890', answer);
    const containers = api.calls.filter((c) => c.path === 'me/threads' && c.method === 'POST');
    expect(containers.length).toBeGreaterThan(1);
    expect(containers[0].params.reply_to_id).toBe('17890');
    expect(containers[1].params.reply_to_id).toBe('media-1');
    for (const container of containers)
      expect(container.params.text.length).toBeLessThanOrEqual(500);
    expect(first).toBe('media-1');
    await channel.sendText('feed', 'A new post');
    expect(
      api.calls.filter((c) => c.path === 'me/threads' && c.method === 'POST').at(-1)?.params
        .reply_to_id
    ).toBeUndefined();
    await expect(channel.editText()).rejects.toThrow('cannot be edited');
    await expect(channel.sendText('dm:1', 'x')).rejects.toThrow('Unknown channel id');
  });
});
