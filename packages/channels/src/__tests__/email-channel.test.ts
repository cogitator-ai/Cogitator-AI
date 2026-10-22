import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChannelMessage } from '@cogitator-ai/types';
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

interface StoredMail {
  uid: number;
  source: Uint8Array;
  seen: boolean;
}

const imap = vi.hoisted(() => ({
  mailbox: [] as StoredMail[],
  uidValidity: 1n,
  failConnects: 0,
  clients: [] as unknown[],
  events: [] as string[],
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
    async search(query: { seen?: boolean }): Promise<number[]> {
      return imap.mailbox.filter((mail) => query.seen !== false || !mail.seen).map((m) => m.uid);
    }
    async *fetch(range: number[]): AsyncGenerator<{ uid: number; source: Uint8Array }> {
      for (const mail of imap.mailbox) {
        if (range.includes(mail.uid)) yield { uid: mail.uid, source: mail.source };
      }
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

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
    const { channel, received } = created();
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
    await flush();
    expect(received).toHaveLength(0);
  });

  it('handles a replayed request once', async () => {
    const { channel, received } = created();
    const fields = mailgunFields();
    expect((await channel.handleWebhook(mailgunRequest(fields))).status).toBe(200);
    expect(await channel.handleWebhook(mailgunRequest(fields))).toEqual({
      status: 200,
      body: 'Already received',
    });
    await flush();
    expect(received).toHaveLength(1);
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
    await flush();
    expect(strict.received).toHaveLength(0);

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
    await flush();
    expect(received).toHaveLength(0);
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
    await flush();
    return made.received;
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
    await channel.handleWebhook(mailgunRequest(mailgunFields()));
    await flush();
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
    const { channel, received } = created();
    const headers: [string, string][] = [
      ['From', 'ann@example.com'],
      ['Message-Id', '<same@example.com>'],
    ];
    await channel.handleWebhook(mailgunRequest(mailgunFields({ headers })));
    await channel.handleWebhook(mailgunRequest(mailgunFields({ headers })));
    await flush();
    expect(received).toHaveLength(1);
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
    await flush();
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

  it('trusts only the topmost results, or those of the servers named', () => {
    const headers: [string, string][] = [
      ['authentication-results', 'mx.mine.com; dkim=fail header.d=example.com'],
      ['authentication-results', 'mx.fake.com; dkim=pass header.d=example.com'],
    ];
    expect(headerAuthentication(headers, 'example.com')).toBe('fail');
    expect(headerAuthentication(headers, 'example.com', ['mx.fake.com'])).toBe('pass');
    expect(headerAuthentication([], 'example.com')).toBe('none');
  });
});
