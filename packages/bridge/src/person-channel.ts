import { randomBytes } from 'node:crypto';
import type { Channel, ChannelAction, ChannelMessage } from '@cogitator-ai/types';
import type { PersonCalls, PersonLetter, PersonRequest, PersonRoute } from './person.js';
import type { Verdict } from './types.js';

export interface ChannelRouteOptions {
  /** The channel the person is reached on. The route registers its handlers and starts it */
  channel: Channel;
  /**
   * The chat of the person on that channel. Letters go there, and only what comes from there is
   * taken for their word
   */
  chatId: string;
  /**
   * Who in that chat may answer, by the channel's user ids. Everybody in the chat by default,
   * which is right for a private chat and wrong for a group
   */
  userIds?: readonly string[];
  /** Hears what went wrong while a message or a button press was handled */
  onError?: (error: Error) => void;
}

/** A route to the person that is started and stopped with its channel. */
export interface ChannelPersonRoute extends PersonRoute {
  /** Starts the channel and tells the person again of everything that waits for them */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** What the data of the route's buttons starts with. A press with other data is not its own. */
const BUTTON_PREFIX = 'bridge:';
const ALLOW = 'a';
const DENY = 'd';

interface Shown {
  /** The short name of the letter in button data, which has room for little */
  token: string;
  call: boolean;
  from: string;
  messages: string[];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function messageOf({ letter, job, again }: PersonRequest, call: boolean): string {
  return [
    `${again ? 'Still waiting. ' : ''}Job #${job.number} "${job.title}" in ${job.project}`,
    `${letter.from} ${call ? 'asks leave' : 'asks'}:`,
    '',
    letter.body,
    '',
    call ? 'Allow or refuse with the buttons.' : 'Reply to this message with your answer.',
  ].join('\n');
}

/**
 * Reaches the person in a chat of a messaging channel, such as Telegram: a letter that waits
 * for them arrives as a message, a permission request with Allow and Refuse buttons under it, a
 * question to be answered by replying to it. What they press or write goes to the bridge as
 * their answer. Only the one chat is listened to, and in it only `userIds` when given.
 *
 * Which message stands for which letter is kept in memory: after a restart `start` tells the
 * person again of what still waits, and a button of an older message says it is not open any
 * more. Give the route a bot of its own: a channel hands its messages to one handler.
 *
 * @example
 * ```ts
 * import { telegramChannel } from '@cogitator-ai/channels';
 *
 * const telegram = channelRoute({ channel: telegramChannel({ token }), chatId: '123456' });
 * const host = await hostBridge({ person: personRoutes([inboxRoute(inbox), telegram]) });
 * await telegram.start();
 * ```
 */
export function channelRoute(options: ChannelRouteOptions): ChannelPersonRoute {
  const { channel, chatId } = options;
  const onError = options.onError ?? (() => undefined);
  const shown = new Map<string, Shown>();
  const byToken = new Map<string, string>();
  const byMessage = new Map<string, string>();
  let bridge: PersonCalls | undefined;
  let started = false;

  const mayAnswer = (from: { channelId: string; userId: string }): boolean =>
    from.channelId === chatId &&
    (options.userIds === undefined || options.userIds.includes(from.userId));

  async function ask(request: PersonRequest): Promise<void> {
    const { letter } = request;
    const call = letter.kind === 'permission' && letter.ask !== undefined;
    const known = shown.get(letter.id);
    const entry: Shown = known ?? {
      token: randomBytes(6).toString('hex'),
      call,
      from: letter.from,
      messages: [],
    };
    shown.set(letter.id, entry);
    byToken.set(entry.token, letter.id);
    const messageId = await channel.sendText(chatId, messageOf(request, call), {
      format: 'plain',
      ...(call && {
        buttons: [
          [
            { text: 'Allow', data: `${BUTTON_PREFIX}${ALLOW}:${entry.token}`, style: 'success' },
            { text: 'Refuse', data: `${BUTTON_PREFIX}${DENY}:${entry.token}`, style: 'danger' },
          ],
        ],
      }),
    });
    entry.messages.push(messageId);
    byMessage.set(messageId, letter.id);
  }

  async function settle({ letter }: PersonLetter): Promise<void> {
    const entry = shown.get(letter.id);
    if (!entry) return;
    shown.delete(letter.id);
    byToken.delete(entry.token);
    for (const messageId of entry.messages) {
      byMessage.delete(messageId);
      if (entry.call) await channel.editButtons?.(chatId, messageId, null).catch(onError);
    }
  }

  async function pressed(action: ChannelAction): Promise<void> {
    if (!action.data.startsWith(BUTTON_PREFIX)) return;
    const say = (text: string, alert = false) =>
      channel.answerAction?.(action.id, { text, alert }) ?? Promise.resolve();
    const [kind, token] = action.data.slice(BUTTON_PREFIX.length).split(':');
    const verdict: Verdict | undefined =
      kind === ALLOW ? 'allow' : kind === DENY ? 'deny' : undefined;
    const letter = token === undefined ? undefined : byToken.get(token);
    if (!mayAnswer(action)) return say('This is not yours to answer', true);
    if (!bridge || !verdict || !letter) return say('This request is not open any more', true);
    try {
      await bridge.personAnswer({ letter, verdict });
      await say(verdict === 'allow' ? 'Allowed' : 'Refused');
    } catch (error) {
      await say(asError(error).message, true);
    }
  }

  async function written(message: ChannelMessage): Promise<void> {
    if (!mayAnswer(message) || message.replyTo === undefined) return;
    const letter = byMessage.get(message.replyTo);
    const entry = letter === undefined ? undefined : shown.get(letter);
    if (!bridge || letter === undefined || !entry) return;
    const say = (text: string) =>
      channel.sendText(chatId, text, { format: 'plain', replyTo: message.id });
    if (entry.call) {
      await say('This one takes a decision: use the buttons under it.');
      return;
    }
    if (message.text.trim() === '') {
      await say('The answer is empty. Reply with words.');
      return;
    }
    try {
      await bridge.personAnswer({ letter, body: message.text });
      await say(`Sent to ${entry.from}.`);
    } catch (error) {
      await say(asError(error).message);
    }
  }

  return {
    attach(calls) {
      bridge = calls;
    },
    ask,
    settle,
    async tell({ jobs, text }) {
      const about = jobs.map((job) => `#${job.number} "${job.title}"`).join(', ');
      await channel.sendText(chatId, `${text}\nIt stands still: job ${about}.`, {
        format: 'plain',
      });
    },
    async start() {
      if (started) return;
      started = true;
      channel.onMessage((message) => written(message).catch(onError));
      channel.onAction?.((action) => pressed(action).catch(onError));
      await channel.start();
      for (const waited of (await bridge?.forPerson()) ?? []) {
        await ask({ ...waited, again: true }).catch(onError);
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      await channel.stop();
    },
  };
}
