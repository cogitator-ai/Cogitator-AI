import { afterEach, describe, expect, it } from 'vitest';
import { experimental_Inbox } from '@cogitator-ai/core';
import type {
  Channel,
  ChannelAction,
  ChannelButton,
  ChannelMessage,
  InboxItem,
  SendOptions,
} from '@cogitator-ai/types';
import { personRoutes, type PersonRoute } from '../person';
import { channelRoute } from '../person-channel';
import { inboxItemId, inboxRoute } from '../person-inbox';
import type { PermissionAsk } from '../types';
import { makeKit, type Kit } from './bridge-kit';

let kit: Kit;

afterEach(async () => {
  await kit.close();
});

const PUSH: PermissionAsk = { tool: 'Bash', access: 'command', command: 'git push origin main' };

/** A job Claude handed to Codex on a bridge that reaches the person by `person`. */
async function bridged(person: PersonRoute, rights: 'ask' | 'allow' = 'ask') {
  kit = await makeKit({ person, rights: () => rights });
  const { bridge, claude, codex } = kit;
  const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
  await bridge.inbox(codex.name);
  const leave = () =>
    bridge.send(codex.name, {
      job: job.number,
      kind: 'permission',
      body: 'Run `git push origin main`',
      ask: PUSH,
    });
  const question = async (body = 'Which release?') => {
    const { letter } = await bridge.send(codex.name, { job: job.number, kind: 'question', body });
    await bridge.escalate(claude.name, { letter: letter.id });
    return letter;
  };
  return { bridge, claude, codex, job, leave, question };
}

describe('the inbox as a route to the person', () => {
  it('shows a permission request as an approval and a question as a question, and tells the sinks', async () => {
    const told: InboxItem[] = [];
    const inbox = new experimental_Inbox({
      sinks: [{ name: 'test', notify: (item) => void told.push(item) }],
    });
    const { bridge, leave, question } = await bridged(inboxRoute(inbox));

    const { letter: request } = await leave();
    const asked = await question();
    await bridge.idle();

    expect(await inbox.get(inboxItemId(request.id))).toMatchObject({
      kind: 'approval',
      status: 'unread',
      title: 'codex@demo asks leave on job #1: Ship the fix',
      summary: 'Run `git push origin main`',
      body: 'Run `git push origin main`',
      actions: [
        { id: 'allow', label: 'Allow', kind: 'approve' },
        { id: 'deny', label: 'Refuse', kind: 'reject' },
      ],
      metadata: {
        bridge: {
          job: 1,
          letter: request.id,
          from: 'codex@demo',
          project: '/work/demo',
          ask: PUSH,
        },
      },
    });
    expect(await inbox.get(inboxItemId(asked.id))).toMatchObject({
      kind: 'question',
      title: 'codex@demo asks on job #1: Ship the fix',
      actions: [{ id: 'reply', label: 'Reply', kind: 'reply' }],
    });
    expect(told.map((item) => item.kind)).toEqual(['approval', 'question']);
  });

  it('marks the item answered and puts it away once the letter waits no more', async () => {
    const inbox = new experimental_Inbox();
    const { bridge, leave } = await bridged(inboxRoute(inbox));
    const { letter } = await leave();
    await bridge.idle();

    await bridge.personAnswer({ letter: letter.id, verdict: 'deny' });
    await bridge.idle();

    const item = await inbox.get(inboxItemId(letter.id));
    expect(item).toMatchObject({ status: 'archived' });
    expect(item?.answeredAt).toBeTypeOf('number');
    expect(kit.errors).toEqual([]);
  });

  it('tells the sinks again when the person is reminded', async () => {
    const told: string[] = [];
    const inbox = new experimental_Inbox({
      sinks: [{ name: 'test', notify: (item) => void told.push(item.status) }],
    });
    const { bridge, leave } = await bridged(inboxRoute(inbox));
    const { letter } = await leave();
    await bridge.idle();
    await inbox.markRead(inboxItemId(letter.id));

    kit.clock.advance(bridge.limits.personReplyTimeoutMs + 1);
    await bridge.sweep();
    await bridge.idle();

    expect(told).toEqual(['unread', 'unread']);
    expect((await inbox.get(inboxItemId(letter.id)))?.status).toBe('unread');
  });
});

interface Sent {
  id: string;
  chat: string;
  text: string;
  buttons?: ChannelButton[][] | null;
  replyTo?: string;
}

/** A channel that keeps what it sent and lets a test write and press as a user. */
function fakeChannel() {
  const sent: Sent[] = [];
  const answers: { action: string; text?: string; alert?: boolean }[] = [];
  let onMessage: ((message: ChannelMessage) => Promise<void>) | undefined;
  let onAction: ((action: ChannelAction) => Promise<void>) | undefined;
  let running = false;
  let events = 0;
  const channel: Channel = {
    type: 'telegram',
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onAction: (handler) => {
      onAction = handler;
    },
    sendText: async (chat: string, text: string, options?: SendOptions) => {
      const id = `m${sent.length + 1}`;
      sent.push({
        id,
        chat,
        text,
        ...(options?.buttons && { buttons: options.buttons }),
        ...(options?.replyTo && { replyTo: options.replyTo }),
      });
      return id;
    },
    editText: async () => undefined,
    sendFile: async () => undefined,
    sendTyping: async () => undefined,
    answerAction: async (action, options) => {
      answers.push({ action, ...options });
    },
    editButtons: async (_chat, messageId, buttons) => {
      const message = sent.find((candidate) => candidate.id === messageId);
      if (message) message.buttons = buttons;
    },
  };
  return {
    channel,
    sent,
    answers,
    running: () => running,
    write: (text: string, from: { chat?: string; user?: string; replyTo?: string } = {}) =>
      onMessage?.({
        id: `u${(events += 1)}`,
        channelType: 'telegram',
        channelId: from.chat ?? 'chat-1',
        userId: from.user ?? 'pavel',
        text,
        ...(from.replyTo && { replyTo: from.replyTo }),
        raw: {},
      }),
    press: (data: string, from: { chat?: string; user?: string } = {}) =>
      onAction?.({
        id: `a${(events += 1)}`,
        channelType: 'telegram',
        channelId: from.chat ?? 'chat-1',
        userId: from.user ?? 'pavel',
        data,
        raw: {},
      }),
  };
}

const dataOf = (message: Sent, label: string): string => {
  const button = message.buttons?.flat().find((candidate) => candidate.text === label);
  if (!button?.data) throw new Error(`No button ${label}`);
  return button.data;
};

describe('a chat as a route to the person', () => {
  it('sends a permission request with buttons, and a press decides it', async () => {
    const chat = fakeChannel();
    const route = channelRoute({ channel: chat.channel, chatId: 'chat-1' });
    const { bridge, codex, leave } = await bridged(route);
    await route.start();

    const { letter } = await leave();
    await bridge.idle();

    expect(chat.running()).toBe(true);
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]).toMatchObject({
      chat: 'chat-1',
      text: [
        'Job #1 "Ship the fix" in /work/demo',
        'codex@demo asks leave:',
        '',
        'Run `git push origin main`',
        '',
        'Allow or refuse with the buttons.',
      ].join('\n'),
    });
    expect(chat.sent[0].buttons?.[0].map((button) => [button.text, button.style])).toEqual([
      ['Allow', 'success'],
      ['Refuse', 'danger'],
    ]);
    expect(Buffer.byteLength(dataOf(chat.sent[0], 'Allow'))).toBeLessThanOrEqual(64);

    await chat.press(dataOf(chat.sent[0], 'Allow'));
    await bridge.idle();

    expect(await bridge.verdict(codex.name, { letter: letter.id })).toMatchObject({
      verdict: 'allow',
      by: 'person',
    });
    expect(chat.answers.at(-1)).toMatchObject({ text: 'Allowed', alert: false });
    expect(chat.sent[0].buttons).toBeNull();
  });

  it('takes a reply to a question for its answer', async () => {
    const chat = fakeChannel();
    const route = channelRoute({ channel: chat.channel, chatId: 'chat-1' });
    const { bridge, codex, question } = await bridged(route);
    await route.start();
    await question();
    await bridge.idle();

    expect(chat.sent[0].text).toContain(
      'codex@demo asks:\n\nWhich release?\n\nReply to this message'
    );
    expect(chat.sent[0].buttons).toBeUndefined();
    await chat.write('Just thinking aloud');
    await chat.write('   ', { replyTo: chat.sent[0].id });
    await chat.write('The one in March', { replyTo: chat.sent[0].id });
    await bridge.idle();

    expect(chat.sent.slice(1).map((message) => message.text)).toEqual([
      'The answer is empty. Reply with words.',
      'Sent to codex@demo.',
    ]);
    expect((await bridge.inbox(codex.name)).map((got) => [got.from, got.body])).toEqual([
      ['person', 'The one in March'],
    ]);
  });

  it('listens to nobody but the person: another chat, another user, a press that is not its own', async () => {
    const chat = fakeChannel();
    const route = channelRoute({ channel: chat.channel, chatId: 'chat-1', userIds: ['pavel'] });
    const { bridge, leave, question } = await bridged(route);
    await route.start();
    const { letter } = await leave();
    await question();
    await bridge.idle();
    const allow = dataOf(chat.sent[0], 'Allow');

    await chat.press(allow, { chat: 'chat-2' });
    await chat.press(allow, { user: 'someone-else' });
    await chat.press('cogitator:approve');
    await chat.write('Me too', { replyTo: chat.sent[1].id, user: 'someone-else' });
    await chat.write('Use words', { replyTo: chat.sent[0].id });
    await bridge.idle();

    expect(chat.answers).toEqual([
      { action: 'a1', text: 'This is not yours to answer', alert: true },
      { action: 'a2', text: 'This is not yours to answer', alert: true },
    ]);
    expect(chat.sent.at(-1)?.text).toBe('This one takes a decision: use the buttons under it.');
    expect((await bridge.forPerson()).map((waited) => waited.letter.id)).toContain(letter.id);
    expect(await bridge.forPerson()).toHaveLength(2);
  });

  it('says so when a button is pressed for a request that is not open any more', async () => {
    const chat = fakeChannel();
    const route = channelRoute({ channel: chat.channel, chatId: 'chat-1' });
    const { bridge, claude, job, leave } = await bridged(route);
    await route.start();
    await leave();
    await bridge.idle();
    const refuse = dataOf(chat.sent[0], 'Refuse');

    await bridge.send(claude.name, {
      job: job.number,
      kind: 'answer',
      body: 'No',
      verdict: 'deny',
    });
    await bridge.idle();
    await chat.press(refuse);

    expect(chat.sent[0].buttons).toBeNull();
    expect(chat.answers).toEqual([
      { action: 'a1', text: 'This request is not open any more', alert: true },
    ]);
  });

  it('tells the person again of what still waits when it starts, and on a reminder', async () => {
    const before = fakeChannel();
    const first = channelRoute({ channel: before.channel, chatId: 'chat-1' });
    const { bridge, codex, leave } = await bridged(first);
    await first.start();
    const { letter } = await leave();
    await bridge.idle();

    const after = fakeChannel();
    const second = channelRoute({ channel: after.channel, chatId: 'chat-1' });
    second.attach?.(bridge);
    await second.start();

    expect(after.sent.map((message) => message.text.split('\n')[0])).toEqual([
      'Still waiting. Job #1 "Ship the fix" in /work/demo',
    ]);
    await after.press(dataOf(after.sent[0], 'Refuse'));
    expect(await bridge.verdict(codex.name, { letter: letter.id })).toMatchObject({
      verdict: 'deny',
    });
    await second.stop();
    expect(after.running()).toBe(false);
  });
});

describe('several routes to the person', () => {
  it('tell the person on each, and a route that fails does not silence the others', async () => {
    const chat = fakeChannel();
    const inbox = new experimental_Inbox();
    const broken: PersonRoute = {
      ask: () => {
        throw new Error('the pager is down');
      },
      settle: () => undefined,
    };
    const route = channelRoute({ channel: chat.channel, chatId: 'chat-1' });
    const { bridge, leave } = await bridged(personRoutes([broken, inboxRoute(inbox), route]));
    await route.start();

    const { letter } = await leave();
    await bridge.idle();

    expect(await inbox.get(inboxItemId(letter.id))).not.toBeNull();
    expect(chat.sent).toHaveLength(1);
    expect(kit.errors.map((error) => error.message)).toEqual(['the pager is down']);
  });
});
