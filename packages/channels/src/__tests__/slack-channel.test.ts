import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '@cogitator-ai/types';

type Listener = (event: Record<string, unknown>) => Promise<void>;

const state = vi.hoisted(() => ({
  apps: [] as Array<{
    config: Record<string, unknown>;
    handler: Listener | null;
    mentionHandler: Listener | null;
    client: Record<string, Record<string, ReturnType<typeof import('vitest').vi.fn>>>;
  }>,
}));

vi.mock('@slack/bolt', () => {
  class App {
    handler: Listener | null = null;
    mentionHandler: Listener | null = null;
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '200.1' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      files: { uploadV2: vi.fn().mockResolvedValue({}) },
      reactions: { add: vi.fn().mockResolvedValue({}) },
      users: { info: vi.fn().mockResolvedValue({ user: { real_name: 'Ann Lee' } }) },
    };
    constructor(readonly config: Record<string, unknown>) {
      state.apps.push(this);
    }
    message(h: Listener) {
      this.handler = h;
    }
    event(name: string, h: Listener) {
      if (name === 'app_mention') this.mentionHandler = h;
    }
    async start() {}
    async stop() {}
  }
  return { App };
});

const { SlackChannel } = await import('../channels/slack');

describe('SlackChannel', () => {
  beforeEach(() => {
    state.apps.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function started(options: { mentionOnly?: boolean; appToken?: string } = {}) {
    const channel = new SlackChannel({ token: 'xoxb', signingSecret: 's', ...options });
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);
    await channel.start();
    return { channel, handler, app: state.apps[0] };
  }

  it('sets groupId for channel messages but not for DMs, and resolves names', async () => {
    const { handler, app } = await started();

    await app.handler!({
      message: { ts: '1.1', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'hey' },
    });
    await app.handler!({
      message: { ts: '1.2', channel: 'D1', channel_type: 'im', user: 'U1', text: 'dm' },
    });

    const [inChannel, inDm] = handler.mock.calls.map((c) => c[0] as ChannelMessage);
    expect(inChannel.groupId).toBe('C1');
    expect(inChannel.userName).toBe('Ann Lee');
    expect(inDm.groupId).toBeUndefined();
    expect(app.client.users.info).toHaveBeenCalledTimes(1);
  });

  it('answers an @mention delivered as app_mention, without the mention in the text', async () => {
    const { handler, app } = await started();

    await app.mentionHandler!({
      event: { ts: '7.1', channel: 'C1', user: 'U1', text: '<@B0T> what is up?' },
      context: { botUserId: 'B0T' },
    });

    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg.text).toBe('what is up?');
    expect(msg.groupId).toBe('C1');
  });

  it('handles a mention once when it arrives as both message and app_mention', async () => {
    const { handler, app } = await started();
    const event = { ts: '8.1', channel: 'C1', user: 'U1', text: '<@B0T> hi' };

    await app.handler!({
      message: { ...event, channel_type: 'channel' },
      context: { botUserId: 'B0T' },
    });
    await app.mentionHandler!({ event, context: { botUserId: 'B0T' } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as ChannelMessage).text).toBe('hi');
  });

  it('with mentionOnly answers channel messages only when mentioned, and DMs always', async () => {
    const { handler, app } = await started({ mentionOnly: true });
    const context = { botUserId: 'B0T' };

    await app.handler!({
      message: { ts: '9.1', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'chatter' },
      context,
    });
    await app.handler!({
      message: {
        ts: '9.2',
        channel: 'C1',
        channel_type: 'channel',
        user: 'U1',
        text: '<@B0T> hey',
      },
      context,
    });
    await app.handler!({
      message: { ts: '9.3', channel: 'D1', channel_type: 'im', user: 'U1', text: 'dm' },
      context,
    });

    expect(handler.mock.calls.map((c) => (c[0] as ChannelMessage).text)).toEqual(['hey', 'dm']);
  });

  it('enables Socket Mode only with an app token', async () => {
    await started({ appToken: 'xapp-1' });
    await started();

    expect(state.apps[0].config).toMatchObject({ socketMode: true, appToken: 'xapp-1' });
    expect(state.apps[1].config.socketMode).toBeUndefined();
  });

  it('replies into the thread root for thread messages', async () => {
    const { channel, app } = await started();
    await app.handler!({
      message: { ts: '5.5', thread_ts: '5.0', channel: 'C1', user: 'U1', text: 'in thread' },
    });

    await channel.sendText('C1', 'answer', { replyTo: '5.5' });

    expect(app.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '5.0' })
    );
  });

  it('ignores bot messages and edits but accepts file shares', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)) })
    );
    const { handler, app } = await started();

    await app.handler!({ message: { ts: '1', channel: 'C', bot_id: 'B', text: 'x' } });
    await app.handler!({
      message: { ts: '2', channel: 'C', user: 'U', subtype: 'message_changed', text: 'x' },
    });
    await app.handler!({
      message: {
        ts: '3',
        channel: 'C',
        user: 'U',
        subtype: 'file_share',
        text: '',
        files: [{ url_private: 'https://files/a.png', mimetype: 'image/png', name: 'a.png' }],
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0] as ChannelMessage;
    expect(msg.attachments?.[0]).toEqual(
      expect.objectContaining({ type: 'image', mimeType: 'image/png', filename: 'a.png' })
    );
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      headers: { Authorization: 'Bearer xoxb' },
    });
  });

  it('downloads URL attachments before uploading', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) })
    );
    const { channel, app } = await started();

    await channel.sendFile('C1', {
      type: 'file',
      mimeType: 'application/pdf',
      url: 'https://x/a.pdf',
    });

    const upload = app.client.files.uploadV2.mock.calls[0][0] as { file: unknown };
    expect(Buffer.isBuffer(upload.file)).toBe(true);
  });

  it('maps status emojis to Slack reaction names', async () => {
    const { channel, app } = await started();
    await channel.setReaction('C1', '1.1', '\u{1F44D}');
    expect(app.client.reactions.add).toHaveBeenCalledWith({
      channel: 'C1',
      timestamp: '1.1',
      name: '+1',
    });
  });
});
