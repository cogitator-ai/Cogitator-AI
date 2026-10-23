import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChannelMessage, RunOptions } from '@cogitator-ai/types';
import { Gateway } from '../gateway';
import {
  EMAIL_LOOP_HEADER,
  EmailChannel,
  replySubject,
  type EmailChannelConfig,
  type OutgoingEmail,
} from '../channels/email/channel';
import { allowsSender, decodeMimeWords, parseMailbox } from '../channels/email/address';
import { headerAuthentication, parseAuthenticationResults } from '../channels/email/auth';
import { EMAIL_RECONNECT_MIN_DELAY } from '../channels/email/imap';
import { stripQuotedReply } from '../channels/email/reply';
import { htmlToText, markdownToHtml } from '../formatters/html';
import { defaultThreadKey } from '../thread-key';
import { ownerCommands } from '../middleware/owner-commands';

interface StoredMail {
  uid: number;
  source: Uint8Array;
  seen: boolean;
  /** When the server received it, default now */
  received?: Date;
}

const imap = vi.hoisted(() => ({
  mailbox: [] as StoredMail[],
  uidValidity: 1n,
  failConnects: 0,
  clients: [] as unknown[],
  events: [] as string[],
  searches: [] as { since?: Date }[],
  /** Makes the next source fetch hang until the test resolves it */
  hang: undefined as Promise<void> | undefined,
  failSearches: 0,
}));

vi.mock('imapflow', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class ImapFlow extends Emitter {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      imap.clients.push(this);
    }
    async connect(): Promise<void> {
      if (imap.failConnects > 0) {
        imap.failConnects--;
        throw new Error('connection refused');
      }
    }
    async logout(): Promise<void> {}
    close(): void {}
    async mailboxOpen(): Promise<{ uidValidity: bigint }> {
      return { uidValidity: imap.uidValidity };
    }
    async search(query: { seen?: boolean; since?: Date }): Promise<number[]> {
      imap.searches.push({ ...(query.since && { since: query.since }) });
      if (imap.failSearches > 0) {
        imap.failSearches--;
        throw new Error('search failed');
      }
      return imap.mailbox
        .filter((mail) => query.seen !== false || !mail.seen)
        .filter((mail) => !query.since || (mail.received ?? new Date()) >= query.since)
        .map((m) => m.uid);
    }
    async *fetch(
      range: number[],
      query: { size?: boolean; source?: boolean }
    ): AsyncGenerator<{ uid: number; size?: number; source?: Uint8Array }> {
      if (query.source && imap.hang) await imap.hang;
      for (const mail of imap.mailbox) {
        if (!range.includes(mail.uid)) continue;
        yield {
          uid: mail.uid,
          ...(query.size && { size: mail.source.byteLength }),
          ...(query.source && { source: mail.source }),
        };
      }
    }
    async messageFlagsRemove(range: number[], flags: string[]): Promise<boolean> {
      for (const mail of imap.mailbox) {
        if (range.includes(mail.uid) && flags.includes('\\Seen')) {
          mail.seen = false;
          imap.events.push(`unseen:${mail.uid}`);
        }
      }
      return true;
    }
    async messageFlagsAdd(range: number[], flags: string[]): Promise<boolean> {
      for (const mail of imap.mailbox) {
        if (range.includes(mail.uid) && flags.includes('\\Seen')) {
          mail.seen = true;
          imap.events.push(`seen:${mail.uid}`);
        }
      }
      return true;
    }
  }
  return { ImapFlow };
});

const BOT = 'bot@cogitator.dev';
const SIGNING_KEY = 'mailgun-signing-key';

const channels: EmailChannel[] = [];

beforeEach(() => {
  imap.mailbox = [];
  imap.uidValidity = 1n;
  imap.failConnects = 0;
  imap.clients = [];
  imap.events = [];
  imap.searches = [];
  imap.hang = undefined;
  imap.failSearches = 0;
});

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function transport() {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    transport: {
      sendMail: vi.fn(async (mail: OutgoingEmail) => {
        sent.push(mail);
        return { messageId: mail.messageId };
      }),
    },
  };
}

function created(config: Partial<EmailChannelConfig> = {}) {
  const mail = transport();
  const channel = new EmailChannel({
    address: BOT,
    name: 'Cogi',
    smtp: { transport: mail.transport },
    allowFrom: ['*'],
    webhook: { provider: 'mailgun', signingKey: SIGNING_KEY },
    ...config,
  });
  channels.push(channel);
  const received: ChannelMessage[] = [];
  channel.onMessage(async (msg) => void received.push(msg));
  return { channel, received, sent: mail.sent, transport: mail.transport };
}

let controls = 0;

/**
 * Sends an allowed, signed mail after the ones a test expects to be dropped and waits until it
 * arrives: what came before it is all there is. Resolves with the messages but the control.
 */
async function control(
  made: { channel: EmailChannel; received: ChannelMessage[] },
  sender = 'ann@example.com'
): Promise<ChannelMessage[]> {
  const id = `<control-${++controls}@example.com>`;
  const response = await made.channel.handleWebhook(
    mailgunRequest(
      mailgunFields({
        from: sender,
        sender,
        headers: [
          ['From', sender],
          ['Message-Id', id],
        ],
      })
    )
  );
  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(made.received.map((msg) => msg.id)).toContain(id));
  return made.received.filter((msg) => !msg.id.startsWith('<control-'));
}

let tokens = 0;

interface MailgunMail {
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  sender?: string;
  headers?: [string, string][];
  timestamp?: number;
  token?: string;
  key?: string;
}

function mailgunFields(mail: MailgunMail = {}): Record<string, string> {
  const timestamp = String(mail.timestamp ?? Math.floor(Date.now() / 1000));
  const token = mail.token ?? `token-${++tokens}`;
  const from = mail.from ?? 'Ann Lee <Ann@Example.com>';
  const headers: [string, string][] = mail.headers ?? [
    ['From', from],
    ['Subject', mail.subject ?? 'Quarterly report'],
    ['Message-Id', `<m${tokens}@example.com>`],
  ];
  return {
    timestamp,
    token,
    signature: createHmac('sha256', mail.key ?? SIGNING_KEY)
      .update(timestamp + token)
      .digest('hex'),
    from,
    sender: mail.sender ?? 'ann@example.com',
    subject: mail.subject ?? 'Quarterly report',
    'body-plain': mail.text ?? 'Can you summarize it?',
    ...(mail.html !== undefined && { 'body-html': mail.html }),
    'message-headers': JSON.stringify(headers),
  };
}

function mailgunRequest(fields: Record<string, string>) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: new URLSearchParams(fields).toString(),
  };
}

async function multipart(form: FormData) {
  const response = new Response(form);
  return {
    rawBody: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? '',
  };
}

describe('Mailgun webhooks', () => {
  it('takes a signed route post and maps the mail to a message of its thread', async () => {
    const { channel, received } = created();
    const response = await channel.handleWebhook(
      mailgunRequest(
        mailgunFields({
          headers: [
            ['From', '"Ann Lee" <Ann@Example.com>'],
            ['Subject', 'Re: Quarterly report'],
            ['Message-Id', '<reply-2@example.com>'],
            ['In-Reply-To', '<bot-1@cogitator.dev>'],
            ['References', '<root@example.com> <bot-1@cogitator.dev>'],
          ],
          text: 'Yes, the short one.\n\nOn Mon, Oct 19, 2026 at 10:00 AM Cogi <bot@cogitator.dev> wrote:\n> Which version?\n',
        })
      )
    );
    expect(response).toEqual({ status: 200, body: 'OK' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: '<reply-2@example.com>',
      channelType: 'email',
      channelId: 'ann@example.com',
      userId: 'ann@example.com',
      userName: 'Ann Lee',
      text: 'Yes, the short one.',
      replyTo: '<bot-1@cogitator.dev>',
      topicId: '<root@example.com>',
    });
    expect(defaultThreadKey(received[0])).toBe(
      'email:ann@example.com:<root@example.com>:ann@example.com'
    );
  });

  it('starts the text of a new thread with its subject, and roots the thread at the mail', async () => {
    const { channel, received } = created();
    await channel.handleWebhook(mailgunRequest(mailgunFields({ subject: 'Invoice 42' })));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].text).toBe('Subject: Invoice 42\n\nCan you summarize it?');
    expect(received[0].topicId).toBe(received[0].id);
    expect(received[0].replyTo).toBeUndefined();
  });

  it('refuses unsigned, wrongly signed and stale requests', async () => {
    const made = created();
    const { channel } = made;
    const unsigned = mailgunFields();
    delete unsigned.signature;
    expect((await channel.handleWebhook(mailgunRequest(unsigned))).status).toBe(401);
    expect(
      (await channel.handleWebhook(mailgunRequest(mailgunFields({ key: 'other-key' })))).status
    ).toBe(401);
    const stale = await channel.handleWebhook(
      mailgunRequest(mailgunFields({ timestamp: Math.floor(Date.now() / 1000) - 3600 }))
    );
    expect(stale).toEqual({ status: 401, body: 'Stale signature' });
    expect(await control(made)).toEqual([]);
  });

  it('handles a replayed request once', async () => {
    const made = created();
    const fields = mailgunFields();
    expect((await made.channel.handleWebhook(mailgunRequest(fields))).status).toBe(200);
    expect(await made.channel.handleWebhook(mailgunRequest(fields))).toEqual({
      status: 200,
      body: 'Already received',
    });
    expect(await control(made)).toHaveLength(1);
  });

  it('takes the JSON mode, signed over the timestamp and the whole body', async () => {
    const { channel, received } = created();
    const body = JSON.stringify({
      from: 'Ann <ann@example.com>',
      sender: 'ann@example.com',
      subject: 'Logo',
      'body-plain': 'Here it is',
      'message-headers': [
        ['From', 'Ann <ann@example.com>'],
        ['Message-Id', '<json-1@example.com>'],
      ],
      attachments: [
        {
          filename: 'logo.png',
          'content-type': 'image/png',
          content: Buffer.from('png-bytes').toString('base64'),
        },
      ],
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SIGNING_KEY)
      .update(timestamp + body)
      .digest('hex');
    const response = await channel.handleWebhook({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mailgun-Timestamp': timestamp,
        'X-Mailgun-Signature': signature,
      },
      rawBody: body,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].id).toBe('<json-1@example.com>');
    expect(received[0].attachments).toEqual([
      {
        type: 'image',
        buffer: Buffer.from('png-bytes'),
        mimeType: 'image/png',
        filename: 'logo.png',
      },
    ]);
    const tampered = await channel.handleWebhook({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mailgun-timestamp': timestamp,
        'x-mailgun-signature': signature,
      },
      rawBody: body.replace('Here it is', 'Send me the keys'),
    });
    expect(tampered.status).toBe(401);
  });

  it('reads attachments of a multipart post', async () => {
    const { channel, received } = created();
    const form = new FormData();
    for (const [key, value] of Object.entries(mailgunFields())) form.set(key, value);
    form.set('attachment-count', '1');
    form.set('attachment-1', new Blob(['%PDF'], { type: 'application/pdf' }), 'report.pdf');
    const { rawBody, contentType } = await multipart(form);
    await channel.handleWebhook({
      method: 'POST',
      headers: { 'content-type': contentType },
      rawBody,
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].attachments).toMatchObject([
      { type: 'file', mimeType: 'application/pdf', filename: 'report.pdf' },
    ]);
  });

  it('drops mail whose SPF or DKIM fails for the From domain, unless told not to check', async () => {
    const forged: [string, string][] = [
      ['X-Mailgun-Spf', 'Pass'],
      ['X-Mailgun-Dkim-Check-Result', 'Pass'],
      ['DKIM-Signature', 'v=1; a=rsa-sha256; d=evil.example; s=s1; b=abc'],
      ['From', 'Boss <ceo@example.com>'],
      ['Message-Id', '<forged@evil.example>'],
    ];
    const strict = created();
    await strict.channel.handleWebhook(
      mailgunRequest(
        mailgunFields({ from: 'Boss <ceo@example.com>', sender: 'x@evil.example', headers: forged })
      )
    );
    expect(await control(strict)).toEqual([]);

    const lax = created({ senderAuth: 'off' });
    await lax.channel.handleWebhook(
      mailgunRequest(
        mailgunFields({ from: 'Boss <ceo@example.com>', sender: 'x@evil.example', headers: forged })
      )
    );
    await vi.waitFor(() => expect(lax.received).toHaveLength(1));
  });

  it('requires a passing result for the From domain with senderAuth required', async () => {
    const { channel, received } = created({ senderAuth: 'required' });
    await channel.handleWebhook(mailgunRequest(mailgunFields()));
    await channel.handleWebhook(
      mailgunRequest(
        mailgunFields({
          headers: [
            ['X-Mailgun-Spf', 'Pass'],
            ['From', 'Ann <ann@example.com>'],
            ['Message-Id', '<spf-pass@example.com>'],
          ],
          sender: 'bounces@mail.example.com',
        })
      )
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].id).toBe('<spf-pass@example.com>');
  });
});

describe('Postmark webhooks', () => {
  const payload = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      From: 'ann@example.com',
      FromName: 'Ann Lee',
      FromFull: { Email: 'ann@example.com', Name: 'Ann Lee', MailboxHash: '' },
      Subject: 'Re: Plans',
      MessageID: '22c74902-a0c1-4511-804f-341342852c90',
      TextBody: 'Friday works.\n\n> When?',
      HtmlBody: '<p>Friday works.</p>',
      Headers: [
        { Name: 'Message-ID', Value: '<pm-1@example.com>' },
        { Name: 'In-Reply-To', Value: '<bot-9@cogitator.dev>' },
        { Name: 'References', Value: '<root-9@example.com> <bot-9@cogitator.dev>' },
        { Name: 'X-Spam-Tests', Value: 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS' },
      ],
      Attachments: [],
      ...overrides,
    });
  const basic = (user: string, password: string) =>
    `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  it('takes posts with the right basic auth and refuses the rest', async () => {
    const { channel, received } = created({
      webhook: { provider: 'postmark', basicAuth: { username: 'postmark', password: 's3cret' } },
    });
    const post = (authorization?: string) =>
      channel.handleWebhook({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization && { authorization }),
        },
        rawBody: payload(),
      });
    expect((await post()).status).toBe(401);
    expect((await post(basic('postmark', 'wrong'))).status).toBe(401);
    expect((await post(basic('postmark', 's3cret'))).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: '<pm-1@example.com>',
      channelId: 'ann@example.com',
      userName: 'Ann Lee',
      text: 'Friday works.',
      replyTo: '<bot-9@cogitator.dev>',
      topicId: '<root-9@example.com>',
    });
  });

  it('takes a secret token from the query or a header', async () => {
    const { channel, received } = created({
      webhook: { provider: 'postmark', token: 'tok-123' },
    });
    const post = (query: Record<string, string>, headers: Record<string, string> = {}) =>
      channel.handleWebhook({
        method: 'POST',
        query,
        headers: { 'content-type': 'application/json', ...headers },
        rawBody: payload({
          Headers: [
            { Name: 'Message-ID', Value: `<pm-${Object.keys(headers).length}@example.com>` },
          ],
        }),
      });
    expect((await post({ token: 'nope' })).status).toBe(401);
    expect((await post({ token: 'tok-123' })).status).toBe(200);
    expect((await post({}, { 'X-Webhook-Token': 'tok-123' })).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(2));
  });

  it('uses the DKIM result of the author domain Postmark reports', async () => {
    const { channel, received } = created({
      senderAuth: 'required',
      webhook: { provider: 'postmark', token: 't' },
    });
    const post = (tests: string, id: string) =>
      channel.handleWebhook({
        method: 'POST',
        query: { token: 't' },
        headers: { 'content-type': 'application/json' },
        rawBody: payload({
          Headers: [
            { Name: 'Message-ID', Value: id },
            { Name: 'X-Spam-Tests', Value: tests },
          ],
        }),
      });
    await post('DKIM_SIGNED,SPF_PASS', '<weak@example.com>');
    await post('DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU', '<strong@example.com>');
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].id).toBe('<strong@example.com>');
  });

  it('refuses a body that is not Postmark JSON', async () => {
    const { channel } = created({ webhook: { provider: 'postmark', token: 't' } });
    const response = await channel.handleWebhook({
      method: 'POST',
      query: { token: 't' },
      headers: { 'content-type': 'application/json' },
      rawBody: '{"Attachments": "nope"',
    });
    expect(response.status).toBe(400);
  });
});

describe('SendGrid Inbound Parse', () => {
  function parsedForm(overrides: Record<string, string> = {}) {
    const form = new FormData();
    const fields: Record<string, string> = {
      headers:
        'From: Ann Lee <ann@example.com>\r\nSubject: Weekly\r\nMessage-ID: <sg-1@example.com>\r\nIn-Reply-To: <bot-3@cogitator.dev>\r\nReferences: <root-3@example.com>\r\n <bot-3@cogitator.dev>\r\n',
      from: 'Ann Lee <ann@example.com>',
      subject: 'Weekly',
      html: '<div>Looks <b>good</b>.</div><blockquote>Old text</blockquote>',
      envelope: JSON.stringify({ from: 'ann@example.com', to: [BOT] }),
      dkim: '{@example.com : pass}',
      SPF: 'pass',
      ...overrides,
    };
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return form;
  }

  async function post(channel: EmailChannel, form: FormData, query: Record<string, string>) {
    const { rawBody, contentType } = await multipart(form);
    return channel.handleWebhook({
      method: 'POST',
      query,
      headers: { 'content-type': contentType },
      rawBody,
    });
  }

  it('needs the secret token and maps the parsed post, HTML only mail as text', async () => {
    const { channel, received } = created({
      webhook: { provider: 'sendgrid', token: 'sg-secret' },
    });
    expect((await post(channel, parsedForm(), {})).status).toBe(401);
    expect((await post(channel, parsedForm(), { token: 'sg-secret' })).status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: '<sg-1@example.com>',
      channelId: 'ann@example.com',
      text: 'Looks good.',
      replyTo: '<bot-3@cogitator.dev>',
      topicId: '<root-3@example.com>',
    });
  });

  it('reads attachments with their attachment-info', async () => {
    const { channel, received } = created({ webhook: { provider: 'sendgrid', token: 't' } });
    const form = parsedForm({
      attachments: '1',
      'attachment-info': JSON.stringify({
        attachment1: { filename: 'notes.txt', type: 'text/plain' },
      }),
    });
    form.set('attachment1', new Blob(['hello']), 'attachment1');
    await post(channel, form, { token: 't' });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].attachments).toMatchObject([
      { type: 'file', mimeType: 'text/plain', filename: 'notes.txt' },
    ]);
  });

  it('drops mail SendGrid found unsigned by the From domain', async () => {
    const { channel, received } = created({ webhook: { provider: 'sendgrid', token: 't' } });
    await post(channel, parsedForm({ dkim: '{@evil.example : pass}', SPF: 'fail' }), {
      token: 't',
    });
    await post(
      channel,
      parsedForm({
        headers:
          'From: Ann Lee <ann@example.com>\r\nSubject: Ok\r\nMessage-ID: <sg-ok@example.com>\r\n',
      }),
      { token: 't' }
    );
    await vi.waitFor(() => expect(received.map((msg) => msg.id)).toContain('<sg-ok@example.com>'));
    expect(received.map((msg) => msg.id)).toEqual(['<sg-ok@example.com>']);
  });

  it('parses the raw MIME mode with postal-mime', async () => {
    const { channel, received } = created({ webhook: { provider: 'sendgrid', token: 't' } });
    const email = [
      'From: =?UTF-8?B?0JDQvdC90LA=?= <anna@example.com>',
      'To: bot@cogitator.dev',
      'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=',
      'Message-ID: <raw-1@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hallo, wie geht=E2=80=99s?',
      '',
    ].join('\r\n');
    await post(channel, parsedForm({ email, headers: '', html: '', from: '', subject: '' }), {
      token: 't',
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: '<raw-1@example.com>',
      channelId: 'anna@example.com',
      userName: 'Анна',
      text: 'Subject: Grüße\n\nHallo, wie geht\u2019s?',
    });
  });
});

describe('replies', () => {
  async function inbound(channel: EmailChannel, received: ChannelMessage[], id: string) {
    await channel.handleWebhook(
      mailgunRequest(
        mailgunFields({
          headers: [
            ['From', 'Ann Lee <ann@example.com>'],
            ['Subject', 'Quarterly report'],
            ['Message-Id', id],
          ],
        })
      )
    );
    await vi.waitFor(() => expect(received.at(-1)?.id).toBe(id));
    return received.at(-1)!;
  }

  it('answers in the thread: Re: subject, In-Reply-To, References, HTML and a text part', async () => {
    const { channel, received, sent } = created();
    const msg = await inbound(channel, received, '<q1@example.com>');
    const id = await channel.sendText(msg.channelId, 'Revenue is **up** 12%.\n\n- EU\n- US', {
      replyTo: msg.id,
      topicId: msg.topicId,
      format: 'markdown',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { name: 'Cogi', address: BOT },
      to: 'ann@example.com',
      subject: 'Re: Quarterly report',
      messageId: id,
      inReplyTo: '<q1@example.com>',
      references: ['<q1@example.com>'],
      headers: { [EMAIL_LOOP_HEADER]: 'email', 'Auto-Submitted': 'auto-replied' },
    });
    expect(id).toMatch(/^<[0-9a-f-]+@cogitator\.dev>$/);
    expect(sent[0].html).toContain('<strong>up</strong>');
    expect(sent[0].html).toContain('<li>EU</li>');
    expect(sent[0].text).toBe('Revenue is up 12%.\n\n• EU\n• US');
  });

  it('keeps the whole chain in References as the thread goes on', async () => {
    const { channel, received, sent } = created();
    const first = await inbound(channel, received, '<c1@example.com>');
    const reply = await channel.sendText(first.channelId, 'One', { replyTo: first.id });
    await channel.handleWebhook(
      mailgunRequest(
        mailgunFields({
          headers: [
            ['From', 'Ann <ann@example.com>'],
            ['Subject', 'Re: Quarterly report'],
            ['Message-Id', '<c2@example.com>'],
            ['In-Reply-To', reply],
            ['References', `<c1@example.com> ${reply}`],
          ],
        })
      )
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1].topicId).toBe('<c1@example.com>');
    await channel.sendText('ann@example.com', 'Two', {
      replyTo: received[1].id,
      topicId: received[1].topicId,
    });
    expect(sent[1]).toMatchObject({
      subject: 'Re: Quarterly report',
      inReplyTo: '<c2@example.com>',
      references: ['<c1@example.com>', reply, '<c2@example.com>'],
    });
  });

  it('answers in the latest mail of a topic when there is no mail to reply to', async () => {
    const { channel, received, sent } = created();
    const msg = await inbound(channel, received, '<t1@example.com>');
    await channel.sendText(msg.channelId, 'Reminder', { topicId: msg.topicId });
    expect(sent[0]).toMatchObject({
      inReplyTo: '<t1@example.com>',
      subject: 'Re: Quarterly report',
    });
  });

  it('starts a new thread for an address it has not talked to', async () => {
    const { channel, sent } = created({ subject: 'A note from Cogi' });
    await channel.sendText('Bob@Example.com', 'Hello');
    expect(sent[0]).toMatchObject({ to: 'bob@example.com', subject: 'A note from Cogi' });
    expect(sent[0].inReplyTo).toBeUndefined();
    expect(sent[0].headers['Auto-Submitted']).toBe('auto-generated');
    await expect(channel.sendText('not-an-address', 'x')).rejects.toThrow(/recipient's address/);
  });

  it('sends a file as an attachment with its caption, and cannot edit', async () => {
    const { channel, sent } = created();
    await channel.sendFile('ann@example.com', {
      type: 'file',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'application/pdf',
      filename: 'report.pdf',
      caption: 'The report',
    });
    expect(sent[0].attachments).toEqual([
      { filename: 'report.pdf', content: Buffer.from([1, 2, 3]), contentType: 'application/pdf' },
    ]);
    expect(sent[0].text).toBe('The report');
    await expect(
      channel.sendFile('ann@example.com', {
        type: 'file',
        mimeType: 'text/plain',
        url: '/etc/passwd',
      })
    ).rejects.toThrow(/buffer or an http/);
    await expect(channel.editText()).rejects.toThrow(/cannot be edited/);
    expect(channel.editable).toBe(false);
    expect(channel.maxMessageChars).toBe(Infinity);
  });

  it('subjects get one Re:', () => {
    expect(replySubject('Plans')).toBe('Re: Plans');
    expect(replySubject('RE: re: Plans')).toBe('Re: Plans');
    expect(replySubject('AW: Plans')).toBe('Re: Plans');
  });
});

describe('what reaches the agent', () => {
  async function deliver(config: Partial<EmailChannelConfig>, mail: MailgunMail) {
    const made = created(config);
    await made.channel.handleWebhook(mailgunRequest(mailgunFields(mail)));
    const allowed = config.allowFrom?.find((entry) => entry.includes('@'))?.toLowerCase();
    return control(made, allowed ?? 'ann@example.com');
  }

  it('skips auto-replies, bounces and bulk mail', async () => {
    const auto = (headers: [string, string][]) =>
      deliver(
        {},
        { headers: [['From', 'ann@example.com'], ['Message-Id', '<a@x.com>'], ...headers] }
      );
    expect(await auto([['Auto-Submitted', 'auto-replied']])).toHaveLength(0);
    expect(await auto([['Precedence', 'bulk']])).toHaveLength(0);
    expect(await auto([['X-Autoreply', 'yes']])).toHaveLength(0);
    expect(
      await auto([['Content-Type', 'multipart/report; report-type=delivery-status']])
    ).toHaveLength(0);
    expect(
      await deliver(
        {},
        { from: 'MAILER-DAEMON@mx.example.com', headers: [['Message-Id', '<b@x>']] }
      )
    ).toHaveLength(0);
    expect(await auto([['Auto-Submitted', 'no']])).toHaveLength(1);
  });

  it('never answers itself, its aliases or mail another Cogitator sent', async () => {
    expect(await deliver({}, { from: `Cogi <${BOT.toUpperCase()}>` })).toHaveLength(0);
    expect(
      await deliver({ aliases: ['help@cogitator.dev'] }, { from: 'help@cogitator.dev' })
    ).toHaveLength(0);
    expect(
      await deliver(
        {},
        {
          headers: [
            ['From', 'other-bot@example.com'],
            ['X-Cogitator', 'email'],
          ],
        }
      )
    ).toHaveLength(0);
  });

  it('answers nobody without an allow list, and warns at start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { channel, received } = created({ allowFrom: undefined });
    await channel.start();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No allowFrom set'));
    expect((await channel.handleWebhook(mailgunRequest(mailgunFields()))).status).toBe(200);
    expect(received).toHaveLength(0);
  });

  it('answers the addresses and domains it allows', async () => {
    expect(await deliver({ allowFrom: ['example.com'] }, {})).toHaveLength(1);
    expect(await deliver({ allowFrom: ['bob@example.com'] }, {})).toHaveLength(0);
    expect(await deliver({ allowFrom: ['ANN@example.com'] }, {})).toHaveLength(1);
    expect(allowsSender(['*.example.com'], 'a@mail.example.com')).toBe(true);
    expect(allowsSender(['*.example.com'], 'a@example.com')).toBe(false);
    expect(allowsSender(['@example.com'], 'a@sub.example.com')).toBe(false);
  });

  it('hands a mail over once by its Message-ID, whichever request brings it', async () => {
    const made = created();
    const { channel } = made;
    const headers: [string, string][] = [
      ['From', 'ann@example.com'],
      ['Message-Id', '<same@example.com>'],
    ];
    await channel.handleWebhook(mailgunRequest(mailgunFields({ headers })));
    await channel.handleWebhook(mailgunRequest(mailgunFields({ headers })));
    expect(await control(made)).toHaveLength(1);
  });

  it('skips mail with nothing in it', async () => {
    expect(
      await deliver(
        { includeSubject: false },
        {
          text: '',
          headers: [
            ['From', 'ann@example.com'],
            ['Message-Id', '<e@x>'],
          ],
        }
      )
    ).toHaveLength(0);
  });
});

describe('IMAP', () => {
  const rawMail = (id: string, body = 'Hello there', from = 'Ann <ann@example.com>') =>
    Buffer.from(
      [
        `From: ${from}`,
        `To: ${BOT}`,
        'Subject: Question',
        `Message-ID: ${id}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '',
      ].join('\r\n')
    );

  const imapConfig = { host: 'imap.example.com', auth: { user: BOT, pass: 'app-password' } };

  it('reads unread mail and marks it read only once it was handed over', async () => {
    imap.mailbox.push(
      { uid: 7, source: rawMail('<i7@example.com>', 'First'), seen: false },
      { uid: 8, source: rawMail('<i8@example.com>', 'Second'), seen: false },
      { uid: 6, source: rawMail('<i6@example.com>', 'Old'), seen: true }
    );
    const { channel } = created({ webhook: undefined, imap: imapConfig });
    const received: string[] = [];
    channel.onMessage(async (msg) => {
      imap.events.push(`handled:${msg.id}`);
      received.push(msg.text);
    });
    await channel.start();
    await vi.waitFor(() => expect(imap.events).toHaveLength(4));
    expect(imap.events).toEqual([
      'handled:<i7@example.com>',
      'seen:7',
      'handled:<i8@example.com>',
      'seen:8',
    ]);
    expect(received).toEqual(['Subject: Question\n\nFirst', 'Subject: Question\n\nSecond']);
    expect(imap.clients[0]).toMatchObject({
      options: expect.objectContaining({ host: 'imap.example.com', port: 993, secure: true }),
    });
  });

  it('does not read mail again after a restart', async () => {
    imap.mailbox.push({ uid: 1, source: rawMail('<r1@example.com>'), seen: false });
    const first = created({ webhook: undefined, imap: imapConfig });
    await first.channel.start();
    await vi.waitFor(() => expect(first.received).toHaveLength(1));
    await vi.waitFor(() => expect(imap.mailbox[0].seen).toBe(true));
    await first.channel.stop();

    imap.mailbox.push({ uid: 2, source: rawMail('<r2@example.com>'), seen: false });
    const second = created({ webhook: undefined, imap: imapConfig });
    await second.channel.start();
    await vi.waitFor(() => expect(second.received).toHaveLength(1));
    expect(second.received[0].id).toBe('<r2@example.com>');
  });

  it('reads new mail IDLE reports at once', async () => {
    const { channel, received } = created({ webhook: undefined, imap: imapConfig });
    await channel.start();
    await vi.waitFor(() => expect(imap.searches.length).toBeGreaterThan(0));
    imap.mailbox.push({ uid: 3, source: rawMail('<n3@example.com>'), seen: false });
    (imap.clients[0] as EventEmitter).emit('exists', { count: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(1));
  });

  it('reconnects with a growing wait when the connection drops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { channel, received } = created({ webhook: undefined, imap: imapConfig });
    await channel.start();
    imap.failConnects = 1;
    imap.mailbox.push({ uid: 4, source: rawMail('<c4@example.com>'), seen: false });
    (imap.clients[0] as EventEmitter).emit('close');
    await vi.advanceTimersByTimeAsync(EMAIL_RECONNECT_MIN_DELAY);
    expect(imap.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(EMAIL_RECONNECT_MIN_DELAY);
    expect(imap.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(EMAIL_RECONNECT_MIN_DELAY);
    expect(imap.clients).toHaveLength(3);
    vi.useRealTimers();
    await vi.waitFor(() => expect(received.map((msg) => msg.id)).toContain('<c4@example.com>'));
  });

  it('fails to start when the first connection fails', async () => {
    imap.failConnects = 1;
    const { channel } = created({ webhook: undefined, imap: imapConfig });
    await expect(channel.start()).rejects.toThrow('connection refused');
  });
});

describe('own webhook server', () => {
  it('serves the path, refusing other paths and bodies over the cap', async () => {
    const { channel, received } = created({
      webhook: {
        provider: 'mailgun',
        signingKey: SIGNING_KEY,
        port: 0,
        maxBody: 64 * 1024,
      },
    });
    const listen = vi.spyOn(
      channel as unknown as { listen: (port: number) => Promise<void> },
      'listen'
    );
    await channel.start();
    expect(listen).toHaveBeenCalled();
    const server = (channel as unknown as { server: import('node:http').Server }).server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const ok = await fetch(`${base}/email/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(mailgunFields()).toString(),
    });
    expect(ok.status).toBe(200);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect((await fetch(`${base}/elsewhere`, { method: 'POST', body: 'x' })).status).toBe(404);
    const big = await fetch(`${base}/email/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a'.repeat(128 * 1024),
    });
    expect(big.status).toBe(413);
    await channel.stop();
    expect((await channel.handleWebhook(mailgunRequest(mailgunFields()))).status).toBe(503);
  });

  it('cannot be created without a way to check requests', () => {
    expect(
      () =>
        new EmailChannel({
          address: BOT,
          smtp: { transport: transport().transport },
          webhook: { provider: 'postmark' },
        })
    ).toThrow(/basicAuth or webhook.token/);
    expect(
      () =>
        new EmailChannel({
          address: BOT,
          smtp: { transport: transport().transport },
          webhook: { provider: 'mailgun', signingKey: '' },
        })
    ).toThrow(/signingKey/);
    expect(
      () => new EmailChannel({ address: 'nope', smtp: { transport: transport().transport } })
    ).toThrow(/not an email address/);
  });
});

describe('mail text', () => {
  it('turns HTML into text with links, lists and quotes', () => {
    expect(
      htmlToText(
        '<html><head><style>p { color: red }</style></head><body><p>Hi&nbsp;<b>Ann</b>,</p><p>See <a href="https://example.com/docs">the docs</a>.</p><ol><li>one</li><li>two</li></ol><blockquote>quoted</blockquote><script>x()</script></body></html>'
      )
    ).toBe('Hi Ann,\n\nSee the docs (https://example.com/docs).\n\n1. one\n2. two\n\n> quoted');
  });

  it('strips quoted history and signatures', () => {
    expect(
      stripQuotedReply(
        'Sounds good.\n\nOn Tue, Oct 20, 2026 at 9:14 AM Cogi <\nbot@cogitator.dev> wrote:\n\n> Shall we?\n> Yes'
      )
    ).toBe('Sounds good.');
    expect(stripQuotedReply('Done.\n\n-- \nAnn Lee\nACME')).toBe('Done.');
    expect(
      stripQuotedReply('Ok\n\n-----Original Message-----\nFrom: Cogi\nSent: today\n\nold')
    ).toBe('Ok');
    expect(
      stripQuotedReply(
        'Fine\n\nFrom: Cogi <bot@cogitator.dev>\nSent: Monday\nTo: Ann\nSubject: x\n\nold'
      )
    ).toBe('Fine');
    expect(stripQuotedReply('> a?\nyes\n> b?\nno\n\nSent from my iPhone')).toBe(
      '> a?\nyes\n> b?\nno'
    );
    expect(stripQuotedReply('He wrote: hello\nAnd more')).toBe('He wrote: hello\nAnd more');
    expect(
      stripQuotedReply('Да\n\nпн, 19 окт. 2026 г. в 10:00, Cogi <bot@cogitator.dev>:\n> Подходит?')
    ).toBe('Да');
  });

  it('renders Markdown as escaped HTML with safe links only', () => {
    const html = markdownToHtml(
      '# Plan\n\n<img src=x onerror=alert(1)> [ok](https://a.com) [bad](javascript:alert(1))\n\n```\n<b>code</b>\n```'
    );
    expect(html).toContain('<h1>Plan</h1>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<a href="https://a.com">ok</a>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;b&gt;code&lt;/b&gt;');
  });

  it('decodes encoded names and addresses', () => {
    expect(decodeMimeWords('=?UTF-8?B?0JDQvdC90LA=?= =?UTF-8?Q?_Lee?=')).toBe('Анна Lee');
    expect(parseMailbox('"Lee, Ann" <Ann@Example.COM>')).toEqual({
      address: 'ann@example.com',
      name: 'Lee, Ann',
    });
    expect(parseMailbox('ann@example.com (Ann)')).toEqual({
      address: 'ann@example.com',
      name: 'Ann',
    });
    expect(parseMailbox('undisclosed-recipients:;')).toBeUndefined();
  });
});

describe('sender authentication', () => {
  it('passes only DKIM, SPF or DMARC results for the From domain', () => {
    expect(
      parseAuthenticationResults(
        'mx.google.com; dkim=pass header.i=@example.com header.s=s1; spf=pass (google.com: domain of x) smtp.mailfrom=bounce@mail.example.com',
        'example.com'
      )
    ).toEqual({ authservId: 'mx.google.com', verdict: 'pass' });
    expect(
      parseAuthenticationResults(
        'mx.google.com; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=evil.example; dmarc=none',
        'example.com'
      ).verdict
    ).toBe('fail');
    expect(
      parseAuthenticationResults('mx.google.com; spf=none smtp.mailfrom=example.com', 'example.com')
        .verdict
    ).toBe('none');
  });

  it('trusts only the results of the servers named, the topmost of them', () => {
    const headers: [string, string][] = [
      ['authentication-results', 'mx.mine.com; dkim=fail header.d=example.com'],
      ['authentication-results', 'mx.fake.com; dkim=pass header.d=example.com'],
      ['authentication-results', 'mx.mine.com; dkim=pass header.d=example.com'],
    ];
    const imap = (trustedAuthservIds?: string[]) =>
      headerAuthentication(headers, 'example.com', {
        source: 'imap',
        ...(trustedAuthservIds && { trustedAuthservIds }),
      });
    expect(imap()).toBe('none');
    expect(imap(['mx.mine.com'])).toBe('fail');
    expect(imap(['mx.fake.com'])).toBe('pass');
  });

  it('ignores the headers a sender can add over IMAP: X-Spam-Tests and Received-SPF', () => {
    const injected: [string, string][] = [
      ['authentication-results', 'mx.google.com; dkim=none; spf=softfail; dmarc=fail'],
      ['x-spam-tests', 'DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU'],
      ['received-spf', 'Pass (forged) envelope-from=ceo@example.com'],
      ['authentication-results', 'evil.example; dkim=pass header.d=example.com'],
    ];
    const verdict = (trusted: string[]) =>
      headerAuthentication(injected, 'example.com', {
        source: 'imap',
        trustedAuthservIds: trusted,
      });
    expect(verdict(['mx.google.com'])).toBe('fail');
    expect(verdict([])).toBe('none');
  });

  it("reads Postmark's spam tests only once, and a trusted fail beats them", () => {
    const tests = (...values: string[]): [string, string][] =>
      values.map((value) => ['x-spam-tests', value]);
    const postmark = (headers: [string, string][], trustedAuthservIds?: string[]) =>
      headerAuthentication(headers, 'example.com', {
        source: 'postmark',
        ...(trustedAuthservIds && { trustedAuthservIds }),
      });
    expect(postmark(tests('DKIM_VALID_AU'))).toBe('pass');
    expect(postmark(tests('SPF_FAIL'))).toBe('fail');
    expect(postmark(tests('DKIM_VALID_AU', 'DKIM_VALID_AU'))).toBe('fail');
    expect(
      postmark(
        [
          [
            'authentication-results',
            'mx.inbound.postmarkapp.com; dmarc=fail header.from=example.com',
          ],
          ...tests('DKIM_VALID_AU'),
        ],
        ['mx.inbound.postmarkapp.com']
      )
    ).toBe('fail');
  });

  it('fails Mailgun results the message carries twice', async () => {
    const made = created();
    await made.channel.handleWebhook(
      mailgunRequest(
        mailgunFields({
          headers: [
            ['X-Mailgun-Spf', 'Fail'],
            ['From', 'Ann <ann@example.com>'],
            ['X-Mailgun-Spf', 'Pass'],
            ['Message-Id', '<twice@example.com>'],
          ],
        })
      )
    );
    expect(await control(made)).toEqual([]);
  });

  it('needs trusted servers for senderAuth required over IMAP', () => {
    expect(
      () =>
        new EmailChannel({
          address: BOT,
          smtp: { transport: transport().transport },
          imap: { host: 'imap.example.com', auth: { user: BOT, pass: 'x' } },
          senderAuth: 'required',
        })
    ).toThrow(/trustedAuthservIds/);
  });
});

describe('authentication results with quoted values', () => {
  it('keeps a quoted address one value, and lets a DMARC result for the From domain decide', () => {
    const verdict = (value: string) => parseAuthenticationResults(value, 'victim.com').verdict;
    expect(
      verdict(
        'mx.google.com; spf=pass (google.com: domain of "a;dkim=pass header.d=victim.com"@evil.com) smtp.mailfrom="a;dkim=pass header.d=victim.com"@evil.com; dmarc=fail (p=REJECT) header.from=victim.com'
      )
    ).toBe('fail');
    expect(
      verdict('mx.google.com; spf=pass smtp.mailfrom="a; dkim=pass header.d=victim.com"@evil.com')
    ).toBe('fail');
    expect(
      verdict('mx.google.com; dkim=pass header.d=victim.com; dmarc=fail header.from=victim.com')
    ).toBe('fail');
    expect(
      verdict('mx.google.com; spf=pass (x \\) y) smtp.mailfrom=ann@victim.com; dmarc=none')
    ).toBe('pass');
    expect(verdict('mx.google.com; dmarc=pass header.from="victim.com"')).toBe('pass');
  });

  it('gives a mail with two From headers no sender', async () => {
    imap.mailbox.push({
      uid: 1,
      source: Buffer.from(
        'From: a@evil.com\r\nFrom: ceo@victim.com\r\nMessage-ID: <two@x>\r\nContent-Type: text/plain\r\n\r\nHi\r\n'
      ),
      seen: false,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { channel, received } = created({
      webhook: undefined,
      imap: { host: 'imap.example.com', auth: { user: BOT, pass: 'x' } },
    });
    await channel.start();
    await vi.waitFor(() => expect(imap.mailbox[0].seen).toBe(true));
    expect(received).toEqual([]);
  });
});

describe('forged senders', () => {
  it('takes the address outside quotes and comments, never one inside the display name', () => {
    expect(parseMailbox('"x <ceo@victim.com>" <attacker@evil.com>')).toEqual({
      address: 'attacker@evil.com',
      name: 'x <ceo@victim.com>',
    });
    expect(parseMailbox('(ceo@victim.com) attacker@evil.com')?.address).toBe('attacker@evil.com');
    expect(parseMailbox('x <ceo@victim.com> <attacker@evil.com>')?.address).toBe(
      'attacker@evil.com'
    );
    expect(parseMailbox('"\\"q\\" <ceo@victim.com>" <z@evil.com>')?.address).toBe('z@evil.com');
  });

  it('uses the address Postmark parsed, whatever the display name says', async () => {
    const { channel, received } = created({
      allowFrom: ['victim.com'],
      webhook: { provider: 'postmark', token: 't' },
    });
    const post = (email: string, id: string) =>
      channel.handleWebhook({
        method: 'POST',
        query: { token: 't' },
        headers: { 'content-type': 'application/json' },
        rawBody: JSON.stringify({
          FromFull: { Email: email, Name: 'Boss <ceo@victim.com>' },
          Subject: 'Wire',
          TextBody: 'Pay now',
          Headers: [
            { Name: 'Message-ID', Value: id },
            { Name: 'X-Spam-Tests', Value: 'DKIM_VALID,DKIM_VALID_AU' },
          ],
        }),
      });
    await post('attacker@evil.com', '<pm-evil@evil.com>');
    await post('cfo@victim.com', '<pm-ok@victim.com>');
    expect(received.map((msg) => [msg.channelId, msg.userName])).toEqual([
      ['cfo@victim.com', 'Boss <ceo@victim.com>'],
    ]);
  });

  it('gives owner mail to the agent only when its sender authentication passes', async () => {
    const made = created({ allowFrom: ['example.com'], owners: ['Me@Example.com'] });
    const send = (spf: string, id: string) =>
      made.channel.handleWebhook(
        mailgunRequest(
          mailgunFields({
            from: 'me@example.com',
            sender: 'me@example.com',
            headers: [
              ['X-Mailgun-Spf', spf],
              ['From', 'me@example.com'],
              ['Message-Id', id],
            ],
          })
        )
      );
    await send('Neutral', '<owner-unverified@example.com>');
    await send('Pass', '<owner-verified@example.com>');
    expect((await control(made)).map((msg) => msg.id)).toEqual(['<owner-verified@example.com>']);
  });
});

describe('SendGrid character sets', () => {
  it('decodes each field in the character set SendGrid names', async () => {
    const { channel, received } = created({ webhook: { provider: 'sendgrid', token: 't' } });
    const boundary = 'xYzBoundary';
    const fields: [string, Buffer][] = [
      ['headers', Buffer.from('From: Ann <ann@example.com>\r\nMessage-ID: <cs@example.com>\r\n')],
      ['subject', Buffer.from('Grüße', 'latin1')],
      ['text', Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4])],
      ['charsets', Buffer.from(JSON.stringify({ subject: 'iso-8859-1', text: 'koi8-r' }))],
    ];
    const rawBody = Buffer.concat([
      ...fields.flatMap(([name, value]) => [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
        value,
        Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const response = await channel.handleWebhook({
      method: 'POST',
      query: { token: 't' },
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody,
    });
    expect(response.status).toBe(200);
    expect(received[0]?.text).toBe('Subject: Grüße\n\nПривет');
  });
});

describe('commands and threads', () => {
  it('keeps a command first, so the real owner commands answer it', async () => {
    const made = created({ owners: ['me@example.com'] });
    const commands = ownerCommands({ ownerIds: { email: 'me@example.com' } });
    const send = (subject: string, text: string, id: string) =>
      made.channel.handleWebhook(
        mailgunRequest(
          mailgunFields({
            from: 'me@example.com',
            sender: 'me@example.com',
            subject,
            text,
            headers: [
              ['X-Mailgun-Spf', 'Pass'],
              ['From', 'me@example.com'],
              ['Subject', subject],
              ['Message-Id', id],
            ],
          })
        )
      );
    await send('Switch the model', '/model gpt-5\n\n-- \nMe', '<cmd-1@example.com>');
    await send('/status', '', '<cmd-2@example.com>');
    expect(made.received.map((msg) => msg.text)).toEqual(['/model gpt-5', '/status']);
    const sendText = vi.fn().mockResolvedValue('id');
    const next = vi.fn();
    await commands.handle(
      made.received[0],
      {
        channel: { sendText } as never,
        threadId: 't',
        user: {} as never,
        set: vi.fn(),
        get: vi.fn(),
      },
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('me@example.com', 'Model set to: gpt-5');
  });

  it('roots a reply to the bot that names only In-Reply-To in the thread of that mail', async () => {
    const made = created();
    const first = await control(made).then(() => made.received[0]);
    const reply = await made.channel.sendText(first.channelId, 'Answer', { replyTo: first.id });
    await made.channel.handleWebhook(
      mailgunRequest(
        mailgunFields({
          headers: [
            ['From', 'ann@example.com'],
            ['Message-Id', '<in-reply-only@example.com>'],
            ['In-Reply-To', reply],
          ],
        })
      )
    );
    expect(made.received.at(-1)).toMatchObject({
      id: '<in-reply-only@example.com>',
      topicId: first.id,
    });
  });

  it('answers a topic it no longer remembers without a made-up Re: subject', async () => {
    const { channel, sent } = created();
    await channel.sendText('ann@example.com', 'Reminder', { topicId: '<old-root@example.com>' });
    expect(sent[0]).toMatchObject({
      subject: 'Message from Cogi',
      inReplyTo: '<old-root@example.com>',
      references: ['<old-root@example.com>'],
    });
  });
});

describe('a gateway that does not take the mail', () => {
  it('answers 503 so the provider sends it again, and takes the retry', async () => {
    const { channel } = created();
    const taken: string[] = [];
    let accept = false;
    channel.onMessage(async (msg) => {
      if (!accept) return channel.redeliver(msg);
      taken.push(msg.id);
    });
    const fields = mailgunFields();
    expect((await channel.handleWebhook(mailgunRequest(fields))).status).toBe(503);
    accept = true;
    expect((await channel.handleWebhook(mailgunRequest(fields))).status).toBe(200);
    expect(taken).toHaveLength(1);
  });
});

describe('a webhook answered before the gateway took its mail', () => {
  it('logs the mail when the gateway hands it back after the request was answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { channel } = created();
    let finish = () => {};
    channel.onMessage(
      (msg) =>
        new Promise<void>((resolve) => {
          finish = () => void channel.redeliver(msg).then(resolve);
        })
    );
    const response = channel.handleWebhook(mailgunRequest(mailgunFields()));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await response).status).toBe(200);
    finish();
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped unanswered'))
    );
  });
});

describe('IMAP reading', () => {
  const imapConfig = { host: 'imap.example.com', auth: { user: BOT, pass: 'app-password' } };
  const mail = (id: string, body = 'Hello', extra: string[] = []) =>
    Buffer.from(
      [
        'From: Ann <ann@example.com>',
        `To: ${BOT}`,
        'Subject: Question',
        `Message-ID: ${id}`,
        ...extra,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '',
      ].join('\r\n')
    );

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('leaves mail the gateway refuses unread, and marks mail unread again on redelivery', async () => {
    imap.mailbox.push({ uid: 1, source: mail('<r1@example.com>'), seen: false });
    const { channel } = created({ webhook: undefined, imap: imapConfig });
    let accept = false;
    const taken: ChannelMessage[] = [];
    channel.onMessage(async (msg) => {
      if (!accept) return channel.redeliver(msg);
      taken.push(msg);
    });
    await channel.start();
    await vi.waitFor(() => expect(imap.searches.length).toBeGreaterThan(0));
    await channel.poll();
    expect(imap.mailbox[0].seen).toBe(false);
    accept = true;
    await channel.poll();
    expect(taken.map((msg) => msg.id)).toEqual(['<r1@example.com>']);
    expect(imap.mailbox[0].seen).toBe(true);
    await channel.redeliver(taken[0]);
    expect(imap.events).toContain('unseen:1');
    await channel.poll();
    expect(taken.map((msg) => msg.id)).toEqual(['<r1@example.com>', '<r1@example.com>']);
  });

  it('marks mail a real gateway drops unanswered at stop unread again', async () => {
    imap.mailbox.push({ uid: 1, source: mail('<drop@example.com>'), seen: false });
    const { channel } = created({ webhook: undefined, imap: imapConfig });
    const run = vi.fn(
      (_agent: unknown, options: RunOptions) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const gateway = new Gateway({
      agent: { name: 'bot', id: 'a1', instructions: 'hi', tools: [], config: {} } as never,
      channels: [channel],
      cogitator: { run } as never,
      drainTimeout: 20,
      onError: vi.fn(),
    });
    await gateway.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(imap.mailbox[0].seen).toBe(true);
    await gateway.stop();
    expect(imap.mailbox[0].seen).toBe(false);
  });

  it('marks mail unread once the connection is open again when it was closed', async () => {
    imap.mailbox.push({ uid: 1, source: mail('<later@example.com>'), seen: false });
    const { channel, received } = created({ webhook: undefined, imap: imapConfig });
    await channel.start();
    await vi.waitFor(() => expect(imap.mailbox[0].seen).toBe(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    (imap.clients[0] as EventEmitter).emit('close');
    await channel.redeliver(received[0]);
    expect(imap.mailbox[0].seen).toBe(true);
    await vi.advanceTimersByTimeAsync(EMAIL_RECONNECT_MIN_DELAY);
    vi.useRealTimers();
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(imap.events).toContain('unseen:1');
  });

  it('drops a forged sender with the results of the trusted server, ignoring injected ones', async () => {
    imap.mailbox.push(
      {
        uid: 1,
        source: mail('<forged@example.com>', 'Pay', [
          'Authentication-Results: mx.google.com; dkim=none; spf=fail smtp.mailfrom=example.com; dmarc=fail',
          'X-Spam-Tests: DKIM_VALID_AU',
          'Authentication-Results: mx.google.com; dkim=pass header.d=example.com',
        ]),
        seen: false,
      },
      {
        uid: 2,
        source: mail('<genuine@example.com>', 'Hi', [
          'Authentication-Results: mx.google.com; dkim=pass header.d=example.com',
        ]),
        seen: false,
      }
    );
    const { channel, received } = created({
      webhook: undefined,
      imap: imapConfig,
      trustedAuthservIds: ['mx.google.com'],
    });
    await channel.start();
    await vi.waitFor(() => expect(imap.mailbox.every((m) => m.seen)).toBe(true));
    expect(received.map((msg) => msg.id)).toEqual(['<genuine@example.com>']);
  });

  it('reads only the last lookbackDays of unread mail', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    imap.mailbox.push({ uid: 1, source: mail('<old@example.com>'), seen: false, received: old });
    const recent = created({ webhook: undefined, imap: imapConfig });
    await recent.channel.start();
    await recent.channel.poll();
    expect(recent.received).toEqual([]);
    await recent.channel.stop();
    const wide = created({ webhook: undefined, imap: { ...imapConfig, lookbackDays: 30 } });
    await wide.channel.start();
    await vi.waitFor(() =>
      expect(wide.received.map((msg) => msg.id)).toEqual(['<old@example.com>'])
    );
  });

  it('skips mail over maxBytes without fetching it, marking it read', async () => {
    imap.mailbox.push(
      { uid: 1, source: mail('<big@example.com>', 'x'.repeat(5000)), seen: false },
      { uid: 2, source: mail('<small@example.com>'), seen: false }
    );
    const { channel, received } = created({
      webhook: undefined,
      imap: { ...imapConfig, maxBytes: 2000 },
    });
    await channel.start();
    await vi.waitFor(() => expect(imap.mailbox.every((m) => m.seen)).toBe(true));
    expect(received.map((msg) => msg.id)).toEqual(['<small@example.com>']);
  });

  it('looks again after a failed look when new mail came meanwhile', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { channel, received } = created({ webhook: undefined, imap: imapConfig });
    await channel.start();
    await vi.waitFor(() => expect(imap.searches.length).toBeGreaterThan(0));
    await channel.poll();
    imap.failSearches = 1;
    imap.mailbox.push({ uid: 5, source: mail('<after-error@example.com>'), seen: false });
    const first = channel.poll();
    const second = channel.poll();
    await Promise.all([first, second]);
    expect(received.map((msg) => msg.id)).toEqual(['<after-error@example.com>']);
  });

  it('stops within its timeout when a fetch hangs, closing the connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let release = () => {};
    imap.hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    imap.mailbox.push({ uid: 1, source: mail('<hang@example.com>'), seen: false });
    const { channel } = created({ webhook: undefined, imap: imapConfig });
    await channel.start();
    const client = imap.clients[0] as { close: () => void };
    const close = vi.spyOn(client, 'close');
    let stopped = false;
    const stopping = channel.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    await stopping;
    expect(close).toHaveBeenCalled();
    release();
  });
});

describe('time it takes', () => {
  /** Bytes of hostile input: a linear pass takes milliseconds, a quadratic one minutes */
  const MEGABYTE = 1_000_000;
  const BOUND_MS = 3000;

  const repeated = (unit: string) => unit.repeat(Math.floor(MEGABYTE / unit.length));
  const lines = (line: string) =>
    Array.from({ length: Math.floor(MEGABYTE / (line.length + 1)) }, () => line).join('\n');
  const elapsed = (work: () => unknown) => {
    const started = performance.now();
    work();
    return performance.now() - started;
  };

  it('reads a megabyte of hostile HTML in linear time', { timeout: 60_000 }, () => {
    for (const unit of ['<a', '<!--', '<a href="', '\n> ']) {
      expect(elapsed(() => htmlToText(`${repeated(unit)}x`))).toBeLessThan(BOUND_MS);
    }
    expect(elapsed(() => markdownToHtml(repeated('[a](')))).toBeLessThan(BOUND_MS);
  });

  it('strips quotes of a megabyte of hostile text in linear time', { timeout: 60_000 }, () => {
    expect(elapsed(() => stripQuotedReply(`${repeated('a@')}.`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => stripQuotedReply(`${lines('> a@b.co:')}\nx`))).toBeLessThan(BOUND_MS);
    expect(elapsed(() => stripQuotedReply(`${lines('ann@example.com:')}\n> q`))).toBeLessThan(
      BOUND_MS
    );
  });

  it(
    'renders deep nesting and a megabyte of open emphasis without overflowing or stalling',
    { timeout: 60_000 },
    () => {
      expect(() => markdownToHtml(`${'> '.repeat(30_000)}x`)).not.toThrow();
      const nested = Array.from({ length: 2000 }, (_, k) => `${' '.repeat(k * 2)}- a`).join('\n');
      expect(() => markdownToHtml(nested)).not.toThrow();
      expect(elapsed(() => markdownToHtml(repeated('**a ')))).toBeLessThan(BOUND_MS);
      expect(elapsed(() => markdownToHtml(repeated('[')))).toBeLessThan(BOUND_MS);
    }
  );

  it('keeps model output from forging its own code placeholders', () => {
    const html = markdownToHtml('0 and `x`');
    expect(html).toContain('�0�');
    expect(html.match(/<code/g)).toHaveLength(1);
  });
});
