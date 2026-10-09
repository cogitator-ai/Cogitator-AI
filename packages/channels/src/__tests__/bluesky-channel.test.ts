import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '@cogitator-ai/types';

interface Convo {
  id: string;
  unreadCount: number;
  status?: string;
  members: Array<{ did: string; handle: string; displayName?: string }>;
}

const state = vi.hoisted(() => ({
  notifications: [] as Array<Record<string, unknown>>,
  seenAt: [] as string[],
  posts: [] as Array<Record<string, unknown>>,
  existing: new Map<string, { uri: string; cid: string; record: unknown }>(),
  convos: [] as Convo[],
  requests: [] as Convo[],
  messages: new Map<string, Array<Record<string, unknown>>>(),
  read: [] as Array<{ convoId: string; messageId?: string }>,
  sent: [] as Array<{ convoId: string; message: { text: string } }>,
  accepted: [] as string[],
  allRead: 0,
  proxies: [] as string[],
}));

vi.mock('@atproto/api', () => {
  class CredentialSession {
    session?: { did: string };
    constructor(readonly serviceUrl: URL) {}
    async login() {
      this.session = { did: 'did:plc:bot' };
    }
    async resumeSession() {}
  }
  const chat = {
    chat: {
      bsky: {
        convo: {
          listConvos: async (params: { readState?: string }) => ({
            data: {
              convos: state.convos.filter(
                (c) => params.readState !== 'unread' || c.unreadCount > 0
              ),
            },
          }),
          listConvoRequests: async () => ({ data: { requests: state.requests } }),
          getMessages: async ({ convoId, limit }: { convoId: string; limit: number }) => ({
            data: { messages: (state.messages.get(convoId) ?? []).slice(0, limit) },
          }),
          updateRead: async (input: { convoId: string; messageId?: string }) => {
            state.read.push(input);
            const convo = [...state.convos, ...state.requests].find((c) => c.id === input.convoId);
            if (convo) convo.unreadCount = 0;
            return { data: {} };
          },
          updateAllRead: async () => {
            state.allRead += 1;
            for (const convo of state.convos) convo.unreadCount = 0;
            return { data: {} };
          },
          sendMessage: async (input: { convoId: string; message: { text: string } }) => {
            state.sent.push(input);
            return { data: { id: `msg-${state.sent.length}` } };
          },
          acceptConvo: async ({ convoId }: { convoId: string }) => {
            state.accepted.push(convoId);
            return { data: {} };
          },
          deleteMessageForSelf: async () => ({ data: {} }),
        },
      },
    },
  };
  class Agent {
    constructor(readonly sessionManager: CredentialSession) {}
    get did() {
      return this.sessionManager.session?.did;
    }
    withProxy(type: string, did: string) {
      state.proxies.push(`${type}:${did}`);
      return chat;
    }
    app = {
      bsky: {
        notification: {
          listNotifications: async ({ limit, cursor }: { limit: number; cursor?: string }) => {
            const newestFirst = [...state.notifications].sort((a, b) =>
              String(b.indexedAt).localeCompare(String(a.indexedAt))
            );
            const start = Number(cursor ?? 0);
            const page = newestFirst.slice(start, start + limit);
            return {
              data: {
                notifications: page.map((n) => ({ ...n })),
                ...(start + limit < newestFirst.length && { cursor: String(start + limit) }),
              },
            };
          },
          updateSeen: async ({ seenAt }: { seenAt: string }) => {
            state.seenAt.push(seenAt);
            for (const n of state.notifications) if (String(n.indexedAt) <= seenAt) n.isRead = true;
          },
        },
      },
    };
    com = {
      atproto: {
        repo: {
          createRecord: async (input: { record: Record<string, unknown> }) => {
            const { createdAt: _createdAt, ...record } = input.record;
            state.posts.push(record);
            const uri = `at://did:plc:bot/app.bsky.feed.post/r${state.posts.length}`;
            state.existing.set(uri, { uri, cid: `c${state.posts.length}`, record });
            return { data: { uri, cid: `c${state.posts.length}` } };
          },
          getRecord: async (input: { rkey: string }) => {
            const found = state.existing.get(`at://did:plc:bot/app.bsky.feed.post/${input.rkey}`);
            if (!found) {
              throw Object.assign(new Error('Could not locate record'), {
                status: 400,
                error: 'RecordNotFound',
              });
            }
            return { data: { uri: found.uri, cid: found.cid, value: found.record } };
          },
        },
      },
    };
    async getPosts({ uris }: { uris: string[] }) {
      return { data: { posts: uris.map((uri) => state.existing.get(uri)).filter(Boolean) } };
    }
    async uploadBlob() {
      return { data: { blob: { ref: 'blob' } } };
    }
    async deletePost() {}
  }
  class RichText {
    facets?: unknown[];
    constructor(readonly input: { text: string }) {}
    get text() {
      return this.input.text;
    }
    async detectFacets() {}
  }
  return { CredentialSession, Agent, RichText };
});

const { BlueskyChannel } = await import('../channels/bluesky/channel');

function mention(
  uri: string,
  text: string,
  indexedAt: string,
  extra: Record<string, unknown> = {}
) {
  return {
    uri,
    cid: 'cid',
    author: { did: 'did:plc:reader', handle: 'reader.bsky.social', displayName: 'Reader' },
    reason: 'mention',
    record: { text, ...extra },
    isRead: false,
    indexedAt,
  };
}

async function started(options: { catchUp?: boolean; directMessages?: boolean } = {}) {
  const channel = new BlueskyChannel({
    identifier: 'news.bsky.social',
    appPassword: 'app-pass',
    pollInterval: 60_000,
    ...options,
  });
  const received: ChannelMessage[] = [];
  channel.onMessage(async (msg) => void received.push(msg));
  await channel.start();
  return { channel, received };
}

beforeEach(() => {
  state.notifications.length = 0;
  state.seenAt.length = 0;
  state.posts.length = 0;
  state.existing.clear();
  state.convos.length = 0;
  state.requests.length = 0;
  state.messages.clear();
  state.read.length = 0;
  state.sent.length = 0;
  state.accepted.length = 0;
  state.allRead = 0;
  state.proxies.length = 0;
});

describe('BlueskyChannel', () => {
  it('answers mentions in their thread, oldest first, without the bot handle', async () => {
    const root = 'at://did:plc:reader/app.bsky.feed.post/root';
    state.notifications.push(
      mention(
        'at://did:plc:reader/app.bsky.feed.post/b',
        '@news.bsky.social what changed?',
        '2026-10-09T10:02:00Z',
        {
          reply: { root: { uri: root, cid: 'r' }, parent: { uri: root, cid: 'r' } },
        }
      ),
      mention(
        'at://did:plc:reader/app.bsky.feed.post/a',
        'hello @news.bsky.social',
        '2026-10-09T10:01:00Z'
      )
    );
    const { channel, received } = await started({ directMessages: false });
    expect(received.map((m) => m.text)).toEqual(['hello @news.bsky.social', 'what changed?']);
    expect(received[1]).toMatchObject({
      channelType: 'bluesky',
      channelId: 'post:at://did:plc:reader/app.bsky.feed.post/b',
      userId: 'did:plc:reader',
      userName: 'Reader',
      groupId: `thread:${root}`,
      replyTo: root,
    });
    expect(state.seenAt).toEqual(['2026-10-09T10:02:00Z']);
    await channel.poll();
    expect(received).toHaveLength(2);
    await channel.stop();
  });

  it('pages back through a backlog of more than one page of notifications', async () => {
    for (let index = 0; index < 230; index++) {
      const at = new Date(Date.UTC(2026, 9, 9, 8, 0, index)).toISOString();
      state.notifications.push(
        mention(`at://did:plc:reader/app.bsky.feed.post/n${index}`, `question ${index}`, at)
      );
    }
    const read = mention(
      'at://did:plc:reader/app.bsky.feed.post/old',
      'answered',
      '2026-10-08T00:00:00.000Z'
    );
    state.notifications.push({ ...read, isRead: true });
    const { channel, received } = await started({ directMessages: false });
    expect(received).toHaveLength(230);
    expect(received[0]?.text).toBe('question 0');
    expect(received.at(-1)?.text).toBe('question 229');
    expect(state.seenAt).toEqual([new Date(Date.UTC(2026, 9, 9, 8, 0, 229)).toISOString()]);
    await channel.stop();
  });

  it('skips its own posts and what arrived before the start when told not to catch up', async () => {
    state.notifications.push(
      {
        ...mention('at://did:plc:bot/app.bsky.feed.post/own', 'mine', '2026-10-09T10:00:00Z'),
        author: { did: 'did:plc:bot', handle: 'news.bsky.social' },
      },
      mention('at://did:plc:reader/app.bsky.feed.post/old', 'old', '2026-10-09T10:00:00Z')
    );
    const { channel, received } = await started({ catchUp: false, directMessages: false });
    expect(received).toEqual([]);
    expect(state.seenAt).toHaveLength(1);
    await channel.stop();
  });

  it('answers a post with a thread of posts within 300 graphemes', async () => {
    state.existing.set('at://did:plc:reader/app.bsky.feed.post/q', {
      uri: 'at://did:plc:reader/app.bsky.feed.post/q',
      cid: 'q',
      record: { text: 'question' },
    });
    const { channel } = await started({ directMessages: false });
    const answer = Array.from(
      { length: 12 },
      (_, i) => `Sentence number ${i} of a long answer.`
    ).join(' ');
    const first = await channel.sendText('post:at://did:plc:reader/app.bsky.feed.post/q', answer);
    expect(state.posts.length).toBeGreaterThan(1);
    for (const post of state.posts) expect([...String(post.text)].length).toBeLessThanOrEqual(300);
    expect(first).toBe('at://did:plc:bot/app.bsky.feed.post/r1');
    expect(state.posts[0].reply).toMatchObject({
      parent: { uri: 'at://did:plc:reader/app.bsky.feed.post/q' },
    });
    expect(state.posts[1].reply).toMatchObject({
      root: { uri: 'at://did:plc:reader/app.bsky.feed.post/q' },
      parent: { uri: 'at://did:plc:bot/app.bsky.feed.post/r1' },
    });
    await channel.stop();
  });

  it('posts to its own feed and refuses to edit', async () => {
    const { channel } = await started({ directMessages: false });
    await channel.sendText('feed', 'A new post');
    expect(state.posts[0]).toMatchObject({ text: 'A new post' });
    expect(state.posts[0].reply).toBeUndefined();
    await expect(channel.editText()).rejects.toThrow('cannot be edited');
    expect(channel.editable).toBe(false);
    await expect(channel.sendText('nonsense', 'x')).rejects.toThrow('Unknown channel id');
    await channel.stop();
  });

  it('answers unread direct messages and requests through the chat service, marking them read', async () => {
    state.convos.push({
      id: 'convo-1',
      unreadCount: 2,
      members: [
        { did: 'did:plc:bot', handle: 'news.bsky.social' },
        { did: 'did:plc:reader', handle: 'reader.bsky.social', displayName: 'Reader' },
      ],
    });
    state.messages.set('convo-1', [
      {
        id: 'm2',
        text: 'second',
        sender: { did: 'did:plc:reader' },
        sentAt: '2026-10-09T10:02:00Z',
      },
      {
        id: 'm1',
        text: 'first',
        sender: { did: 'did:plc:reader' },
        sentAt: '2026-10-09T10:01:00Z',
      },
    ]);
    state.requests.push({
      id: 'convo-2',
      unreadCount: 1,
      status: 'request',
      members: [{ did: 'did:plc:stranger', handle: 'stranger.bsky.social' }],
    });
    state.messages.set('convo-2', [
      { id: 'x1', text: 'hi', sender: { did: 'did:plc:stranger' }, sentAt: '2026-10-09T10:03:00Z' },
    ]);
    const { channel, received } = await started({});
    expect(state.proxies).toEqual(['bsky_chat:did:web:api.bsky.chat']);
    expect(received.map((m) => [m.channelId, m.text, m.userName])).toEqual([
      ['dm:convo-1', 'first', 'Reader'],
      ['dm:convo-1', 'second', 'Reader'],
      ['dm:convo-2', 'hi', 'stranger.bsky.social'],
    ]);
    expect(state.read).toEqual([
      { convoId: 'convo-1', messageId: 'm2' },
      { convoId: 'convo-2', messageId: 'x1' },
    ]);
    await channel.sendText('dm:convo-2', 'Hello there');
    expect(state.accepted).toEqual(['convo-2']);
    expect(state.sent).toEqual([{ convoId: 'convo-2', message: { text: 'Hello there' } }]);
    await channel.sendText('dm:convo-2', 'x'.repeat(2500));
    expect(state.sent.slice(1).map((s) => s.message.text.length)).toEqual([1000, 1000, 500]);
    expect(state.accepted).toHaveLength(1);
    await expect(
      channel.sendFile('dm:convo-1', {
        type: 'image',
        mimeType: 'image/png',
        buffer: new Uint8Array(1),
      })
    ).rejects.toThrow('cannot carry files');
    await channel.stop();
  });

  it('marks every conversation read at the start when told not to catch up', async () => {
    state.convos.push({ id: 'c', unreadCount: 3, members: [] });
    const { channel, received } = await started({ catchUp: false });
    expect(state.allRead).toBe(1);
    expect(received).toEqual([]);
    await channel.stop();
  });
});
