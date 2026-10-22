import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { Attachment, Channel, ChannelMessage, SendOptions } from '@cogitator-ai/types';
import { htmlToText, markdownToHtml } from '../../formatters/html';
import { markdownToPlainText } from '../../formatters/plain-text';
import { allowsSender, domainOf, headerOf, isAddress, normalizeAddress } from './address';
import { secretsEqual, verifyMailgunSignature } from './auth';
import { ImapInbox, type EmailImapConfig } from './imap';
import { parseRawEmail, type InboundEmail } from './mime';
import {
  bodyText,
  isForm,
  mailgunFormEmail,
  mailgunJsonEmail,
  postmarkEmail,
  readForm,
  requestHeader,
  sendgridEmail,
  type EmailWebhookRequest,
  type EmailWebhookResponse,
} from './providers';
import { stripQuotedReply } from './reply';

/** The header the channel puts on every mail it sends, and skips mail that carries it. */
export const EMAIL_LOOP_HEADER = 'X-Cogitator';
/** The largest webhook body the channel's own server takes by default, in bytes. */
export const EMAIL_DEFAULT_MAX_BODY = 10 * 1024 * 1024;
/** The largest attachment handed to the agent by default, in bytes. */
export const EMAIL_DEFAULT_MAX_ATTACHMENT = 10 * 1024 * 1024;
/** How old a Mailgun signature may be by default, in seconds. */
export const MAILGUN_DEFAULT_MAX_AGE = 300;

const MAX_TRACKED = 1000;
const MAX_REFERENCES = 20;
const AUTOMATED_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+-.].*)?@/i;

/** Credentials for HTTP basic authentication of a webhook. */
export interface EmailBasicAuth {
  username: string;
  password: string;
}

/** Mailgun signs each request of a route with the webhook signing key. */
export interface MailgunWebhookConfig {
  provider: 'mailgun';
  /** The HTTP webhook signing key of the Mailgun account (Settings, Webhooks) */
  signingKey: string;
  /** How old a signature may be, in seconds (default 300). Older requests are refused as replays */
  maxAge?: number;
}

/**
 * Postmark and SendGrid do not sign inbound mail, so the webhook URL carries a secret: basic
 * authentication (`https://user:password@host/path`) or a `token` query parameter (also taken
 * from an `X-Webhook-Token` header). At least one is required.
 */
export interface SecretWebhookConfig {
  provider: 'postmark' | 'sendgrid';
  basicAuth?: EmailBasicAuth;
  token?: string;
}

export type EmailWebhookConfig = (MailgunWebhookConfig | SecretWebhookConfig) & {
  /**
   * Run an HTTP server of the channel's own on this port. Without it, mount `handleWebhook` or
   * `webhookListener()` in a server of yours.
   */
  port?: number;
  /** The path of the channel's own server (default `/email/webhook`) */
  path?: string;
  host?: string;
  /** The largest body taken, in bytes (default 10 MB), larger ones get `413` */
  maxBody?: number;
};

/** A mail as the channel hands it to the transport, in the shape nodemailer takes. */
export interface OutgoingEmail {
  from: string | { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;
  attachments?: { filename?: string; content?: Buffer; href?: string; contentType?: string }[];
}

/** Anything that sends mail: a nodemailer transporter (SMTP, SES, ...) or one of your own. */
export interface EmailTransport {
  sendMail(mail: OutgoingEmail): Promise<unknown>;
  close?(): void;
}

/** An SMTP server the channel sends through with nodemailer. */
export interface EmailSmtpServer {
  host: string;
  /** Default 587, or 465 when `secure` */
  port?: number;
  /** TLS from the start, as on port 465 (default: true on port 465). Otherwise STARTTLS */
  secure?: boolean;
  auth?: { user: string; pass: string };
  /** Further nodemailer SMTP options */
  options?: Record<string, unknown>;
}

export type EmailSmtpConfig = EmailSmtpServer | { transport: EmailTransport };

/**
 * How mail is checked against the sender authentication results the receiving side reports
 * (DKIM, SPF, DMARC): `when-reported` (default) drops mail whose results fail for the `From`
 * domain and takes mail without results, `required` also drops mail without results, `off`
 * does not look.
 */
export type EmailSenderAuthPolicy = 'required' | 'when-reported' | 'off';

export interface EmailChannelConfig {
  /** The bot's address: mail is sent from it, and mail from it is never answered */
  address: string;
  /** The display name of the mail it sends */
  name?: string;
  /** Other addresses of the bot, also never answered */
  aliases?: string[];
  /** How mail is sent */
  smtp: EmailSmtpConfig;
  /** Read mail from a mailbox over IMAP */
  imap?: EmailImapConfig;
  /** Take mail from a provider's inbound webhook: Mailgun, Postmark or SendGrid */
  webhook?: EmailWebhookConfig;
  /**
   * Who the bot answers: addresses (`ann@example.com`), domains (`example.com`), subdomain
   * wildcards (`*.example.com`) or `*` for everyone. Default: nobody, which `start()` warns
   * about, since anyone can send mail and the `From` address can be forged.
   */
  allowFrom?: string[];
  /** See {@link EmailSenderAuthPolicy}. Default `when-reported` */
  senderAuth?: EmailSenderAuthPolicy;
  /**
   * The authserv-ids (the first word of `Authentication-Results`, such as `mx.google.com`)
   * whose results count, for IMAP and Postmark. Default: the topmost header, whoever wrote it.
   */
  trustedAuthservIds?: string[];
  /** Start the text of a conversation's first mail with its subject (default true) */
  includeSubject?: boolean;
  /** The subject of mail that starts a conversation, such as a reminder (default `Message from <name>`) */
  subject?: string;
  /** The largest attachment handed to the agent, in bytes (default 10 MB), larger ones are skipped */
  maxAttachmentBytes?: number;
}

/** What the channel remembers of a mail, to answer in its thread. */
interface ThreadEntry {
  subject: string;
  references: string[];
  root: string;
}

interface NodemailerModule {
  createTransport(options: Record<string, unknown>): EmailTransport;
}

async function loadNodemailer(): Promise<NodemailerModule> {
  try {
    const module = (await import('nodemailer')) as unknown as
      NodemailerModule | { default: NodemailerModule };
    return 'createTransport' in module ? module : module.default;
  } catch (error) {
    throw new Error(
      'nodemailer is required to send email over SMTP. Install it: pnpm add nodemailer',
      {
        cause: error,
      }
    );
  }
}

function forgetOldest(collection: Set<string> | Map<string, unknown>): void {
  while (collection.size > MAX_TRACKED) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) return;
    collection.delete(oldest);
  }
}

/** `subject` as a reply's subject: with one `Re: `, whatever prefix it had. */
export function replySubject(subject: string): string {
  const base = subject.replace(/^(\s*(re|aw|sv|antw|ответ|отв)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

/** The references of a reply: the first and the latest ids, since a long chain is cut. */
function trimReferences(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length <= MAX_REFERENCES) return unique;
  return [unique[0], ...unique.slice(unique.length - (MAX_REFERENCES - 1))];
}

/** Whether the mail is an automatic one: an auto-reply, a bounce, a list or bulk mailing. */
export function isAutomatedEmail(email: InboundEmail): boolean {
  const header = (name: string) => headerOf(email.headers, name)?.trim().toLowerCase();
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const precedence = header('precedence');
  if (precedence && /^(bulk|junk|list|auto_reply)/.test(precedence)) return true;
  if (header('x-autoreply') || header('x-autorespond') || header('x-autogenerated')) return true;
  if (header('x-failed-recipients')) return true;
  if (header('content-type')?.startsWith('multipart/report')) return true;
  if (header('return-path') === '<>') return true;
  return !!email.from && AUTOMATED_SENDER.test(email.from.address);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge('Webhook body too large'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * An email channel: an agent answers mail, in the thread of each mail. Mail comes from a mailbox
 * over IMAP (`imapflow` and `postal-mime`), or from the inbound webhook of Mailgun, Postmark or
 * SendGrid, and answers go out over SMTP (`nodemailer`) or any transport given, with
 * `In-Reply-To` and `References` set, so mail clients keep them in the thread.
 *
 * A sender is a conversation partner: `channelId` and `userId` are the sender's address in lower
 * case, and `topicId` is the thread's first `Message-ID`, so each email thread is a conversation
 * of its own. Answers are Markdown, sent as HTML with a plain text alternative, and cannot be
 * edited. Mail from the bot itself, mail that carries the `X-Cogitator` header the channel puts
 * on what it sends, auto-replies, bounces and bulk mail are never answered.
 */
export class EmailChannel implements Channel {
  readonly type = 'email';
  readonly editable = false;
  readonly nativeMarkdown = true;
  readonly maxMessageChars = Infinity;
  private readonly config: EmailChannelConfig;
  private readonly address: string;
  private readonly ownAddresses: Set<string>;
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private readonly handled = new Set<string>();
  private readonly signatures = new Set<string>();
  private readonly threads = new Map<string, ThreadEntry>();
  /** The latest mail of each thread, by `address|root` */
  private readonly latest = new Map<string, string>();
  private transport?: Promise<EmailTransport>;
  private inbox?: ImapInbox<InboundEmail>;
  private server?: Server;
  private running = false;
  private stopped = false;

  constructor(config: EmailChannelConfig) {
    const address = normalizeAddress(config.address ?? '');
    if (!isAddress(address)) {
      throw new Error(`[email] "${config.address}" is not an email address: set address`);
    }
    if (!config.smtp) throw new Error('[email] smtp is required: answers are sent with it');
    const webhook = config.webhook;
    if (webhook?.provider === 'mailgun' && !webhook.signingKey) {
      throw new Error('[email] webhook.signingKey is required: Mailgun signs requests with it');
    }
    if (
      webhook &&
      webhook.provider !== 'mailgun' &&
      !webhook.token &&
      !(webhook.basicAuth?.username && webhook.basicAuth.password)
    ) {
      throw new Error(
        `[email] ${webhook.provider} does not sign its webhook: set webhook.basicAuth or webhook.token`
      );
    }
    this.config = config;
    this.address = address;
    this.ownAddresses = new Set([address, ...(config.aliases ?? []).map(normalizeAddress)]);
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.config.allowFrom?.length) {
      console.warn(
        '[email] No allowFrom set: the bot answers nobody. List the addresses or domains it answers, or "*" for everyone'
      );
    } else if (this.config.allowFrom.includes('*') && this.config.senderAuth === 'off') {
      console.warn(
        '[email] allowFrom is "*" and senderAuth is off: anyone can write to the agent, also as someone else'
      );
    }
    if (!this.config.imap && !this.config.webhook) {
      console.warn('[email] Neither imap nor webhook is set: the channel only sends mail');
    }
    this.running = true;
    this.stopped = false;
    try {
      const webhook = this.config.webhook;
      if (webhook?.port !== undefined) {
        await this.listen(webhook.port, webhook.path ?? '/email/webhook', webhook.host);
      }
      if (this.config.imap) {
        this.inbox = new ImapInbox(
          this.config.imap,
          (raw, uid) =>
            parseRawEmail(raw, this.parseOptions()).then((email) => ({
              ...email,
              raw: { uid, email: email.raw },
            })),
          (email) => this.accept(email)
        );
        await this.inbox.start();
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    const server = this.server;
    this.server = undefined;
    const inbox = this.inbox;
    this.inbox = undefined;
    await Promise.all([
      inbox?.stop(),
      server &&
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ]);
    const transport = this.transport;
    this.transport = undefined;
    if (transport) (await transport.catch(() => undefined))?.close?.();
  }

  /** Looks for unread mail over IMAP now, besides IDLE and the poll timer. */
  async poll(): Promise<void> {
    await this.inbox?.sync();
  }

  /**
   * Answers a provider's inbound webhook request: checks its signature or secret, reads the
   * mail, answers at once and hands the mail to the agent after. Mount it in any HTTP server
   * with the raw body unparsed. It works before `start()` too and answers `503` once stopped.
   */
  async handleWebhook(request: EmailWebhookRequest): Promise<EmailWebhookResponse> {
    const webhook = this.config.webhook;
    if (this.stopped) return { status: 503, body: 'The channel is stopped' };
    if (!webhook) return { status: 404, body: 'The webhook is not configured' };
    if (request.method !== 'POST') return { status: 405, body: 'Method not allowed' };
    const raw = request.rawBody ?? '';
    const contentType = requestHeader(request.headers, 'content-type') ?? '';
    if (webhook.provider !== 'mailgun' && !this.authorized(webhook, request)) {
      return { status: 401, body: 'Unauthorized' };
    }
    let email: InboundEmail;
    try {
      if (webhook.provider === 'mailgun') {
        const verified = await this.mailgunEmail(webhook, request, raw, contentType);
        if ('status' in verified) return verified;
        email = verified.email;
      } else if (webhook.provider === 'postmark') {
        email = postmarkEmail(JSON.parse(bodyText(raw)), this.parseOptions());
      } else {
        if (!isForm(contentType)) return { status: 415, body: 'Expected multipart/form-data' };
        email = await sendgridEmail(await readForm(raw, contentType), this.parseOptions());
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('postal-mime is required')) {
        console.error(`[email] ${error.message}`);
        return { status: 500, body: 'Could not read the message' };
      }
      return { status: 400, body: 'Invalid payload' };
    }
    void this.accept(email).catch((error: unknown) =>
      console.error('[email] Webhook mail failed:', error)
    );
    return { status: 200, body: 'OK' };
  }

  /**
   * A Node request listener that answers webhook requests on any path it is mounted at. Bodies
   * over `webhook.maxBody` (10 MB by default) are refused with `413`.
   */
  webhookListener(): RequestListener {
    const limit = this.config.webhook?.maxBody ?? EMAIL_DEFAULT_MAX_BODY;
    return (req, res) => {
      let query: Record<string, string> = {};
      try {
        query = Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      readBody(req, limit)
        .then((rawBody) =>
          this.handleWebhook({ method: req.method ?? 'GET', query, headers: req.headers, rawBody })
        )
        .then((response) =>
          res.writeHead(response.status, { 'content-type': 'text/plain' }).end(response.body)
        )
        .catch((error: unknown) => {
          if (error instanceof BodyTooLarge) {
            res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
            res.end('Payload too large');
            return;
          }
          console.error('[email] Webhook request failed:', error);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
    };
  }

  /**
   * Sends `text` to the address `channelId`. With a `replyTo` of a mail the channel saw, or the
   * `topicId` of a thread, it answers in that thread (`Re:` subject, `In-Reply-To`,
   * `References`), and otherwise it starts a new one. Resolves with the new mail's `Message-ID`.
   */
  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    if (!text.trim()) throw new Error('[email] Nothing to send');
    return this.send(channelId, this.bodies(text, options?.format), options);
  }

  editText(): Promise<void> {
    return Promise.reject(new Error('[email] Sent email cannot be edited'));
  }

  /**
   * Sends a file as an attachment, its caption as the text, in the thread as `sendText` does.
   * A file needs a `buffer` or an `http(s)` url, which nodemailer downloads.
   */
  async sendFile(channelId: string, file: Attachment, options?: SendOptions): Promise<string> {
    const filename = file.filename ?? (file.type === 'image' ? 'image' : 'file');
    let attachment: NonNullable<OutgoingEmail['attachments']>[number];
    if (file.buffer) {
      attachment = { filename, content: Buffer.from(file.buffer), contentType: file.mimeType };
    } else if (file.url && /^https?:\/\//i.test(file.url)) {
      attachment = { filename, href: file.url, contentType: file.mimeType };
    } else {
      throw new Error('[email] A file needs a buffer or an http(s) url');
    }
    const caption = file.caption?.trim() ? file.caption : filename;
    return this.send(channelId, { ...this.bodies(caption, options?.format), attachment }, options);
  }

  async sendTyping(): Promise<void> {}

  private parseOptions() {
    return {
      maxAttachmentBytes: this.config.maxAttachmentBytes ?? EMAIL_DEFAULT_MAX_ATTACHMENT,
      ...(this.config.trustedAuthservIds && {
        trustedAuthservIds: this.config.trustedAuthservIds,
      }),
    };
  }

  private authorized(webhook: SecretWebhookConfig, request: EmailWebhookRequest): boolean {
    if (webhook.token) {
      const given =
        request.query?.token ?? requestHeader(request.headers, 'x-webhook-token') ?? undefined;
      if (given !== undefined && secretsEqual(given, webhook.token)) return true;
    }
    const credentials = webhook.basicAuth;
    const authorization = requestHeader(request.headers, 'authorization');
    if (credentials && authorization?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf-8');
      return secretsEqual(decoded, `${credentials.username}:${credentials.password}`);
    }
    return false;
  }

  /** Checks a Mailgun request's signature, age and token, and reads its mail. */
  private async mailgunEmail(
    webhook: MailgunWebhookConfig,
    request: EmailWebhookRequest,
    raw: string | Uint8Array,
    contentType: string
  ): Promise<EmailWebhookResponse | { email: InboundEmail }> {
    let timestamp: string | undefined;
    let token: string | Uint8Array | undefined;
    let signature: string | undefined;
    let form: FormData | undefined;
    if (isForm(contentType)) {
      form = await readForm(raw, contentType);
      const field = (name: string) => {
        const value = form?.get(name);
        return typeof value === 'string' ? value : undefined;
      };
      timestamp = field('timestamp');
      token = field('token');
      signature = field('signature');
    } else {
      timestamp = requestHeader(request.headers, 'x-mailgun-timestamp');
      signature = requestHeader(request.headers, 'x-mailgun-signature');
      token = raw;
    }
    if (
      !timestamp ||
      token === undefined ||
      !verifyMailgunSignature(timestamp, token, signature, webhook.signingKey)
    ) {
      return { status: 401, body: 'Invalid signature' };
    }
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > (webhook.maxAge ?? MAILGUN_DEFAULT_MAX_AGE)) {
      return { status: 401, body: 'Stale signature' };
    }
    const key = signature ?? '';
    if (this.signatures.has(key)) return { status: 200, body: 'Already received' };
    this.signatures.add(key);
    forgetOldest(this.signatures);
    try {
      const email = form
        ? await mailgunFormEmail(form, this.parseOptions())
        : await mailgunJsonEmail(JSON.parse(bodyText(raw)), this.parseOptions());
      return { email };
    } catch (error) {
      this.signatures.delete(key);
      throw error;
    }
  }

  /** Whether the mail may reach the agent: by its sender, its kind and its authentication. */
  private admits(email: InboundEmail, sender: string): boolean {
    if (this.ownAddresses.has(sender)) return false;
    if (headerOf(email.headers, EMAIL_LOOP_HEADER) !== undefined) return false;
    if (isAutomatedEmail(email)) return false;
    const policy = this.config.senderAuth ?? 'when-reported';
    if (policy !== 'off') {
      if (email.authentication === 'fail') return false;
      if (policy === 'required' && email.authentication !== 'pass') return false;
    }
    return allowsSender(this.config.allowFrom ?? [], sender);
  }

  /** Hands an inbound mail to the agent when it is one to answer. */
  private async accept(email: InboundEmail): Promise<void> {
    if (!this.handler || !email.from) return;
    const sender = email.from.address;
    if (!this.admits(email, sender)) return;
    const messageId = email.messageId ?? this.fallbackId(email, sender);
    const dedupeKey = messageId.toLowerCase();
    if (this.handled.has(dedupeKey)) return;
    const body = stripQuotedReply(
      email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : ''
    );
    const starts = !email.inReplyTo && email.references.length === 0;
    const text =
      starts && email.subject && this.config.includeSubject !== false
        ? `Subject: ${email.subject}${body ? `\n\n${body}` : ''}`
        : body;
    if (!text && email.attachments.length === 0) return;
    this.handled.add(dedupeKey);
    forgetOldest(this.handled);
    const root = email.references[0] ?? email.inReplyTo ?? messageId;
    this.remember(sender, messageId, {
      subject: email.subject,
      references: trimReferences([
        ...(email.references.length ? email.references : email.inReplyTo ? [email.inReplyTo] : []),
        messageId,
      ]),
      root,
    });
    const message: ChannelMessage = {
      id: messageId,
      channelType: this.type,
      channelId: sender,
      userId: sender,
      ...(email.from.name && { userName: email.from.name }),
      text,
      ...(email.attachments.length > 0 && { attachments: email.attachments }),
      ...(email.inReplyTo && { replyTo: email.inReplyTo }),
      topicId: root,
      raw: email.raw,
    };
    try {
      await this.handler(message);
    } catch (error) {
      console.error('[email] Message handler error:', error);
    }
  }

  private fallbackId(email: InboundEmail, sender: string): string {
    const digest = createHash('sha256')
      .update(
        [
          sender,
          headerOf(email.headers, 'date') ?? '',
          email.subject,
          email.text ?? email.html ?? '',
        ].join('\n')
      )
      .digest('hex')
      .slice(0, 32);
    return `<${digest}@cogitator.invalid>`;
  }

  private remember(address: string, messageId: string, entry: ThreadEntry): void {
    this.threads.delete(messageId);
    this.threads.set(messageId, entry);
    forgetOldest(this.threads);
    const key = `${address}|${entry.root}`;
    this.latest.delete(key);
    this.latest.set(key, messageId);
    forgetOldest(this.latest);
  }

  /** The thread a mail to `to` goes in: the mail it answers, or the latest of its topic. */
  private threadOf(
    to: string,
    options: SendOptions | undefined
  ): { inReplyTo?: string; entry?: ThreadEntry; root?: string } {
    const replyTo = options?.replyTo;
    const answered = replyTo ? this.threads.get(replyTo) : undefined;
    if (replyTo && answered) return { inReplyTo: replyTo, entry: answered, root: answered.root };
    const topic = options?.topicId;
    if (topic) {
      const latest = this.latest.get(`${to}|${topic}`);
      const entry = latest ? this.threads.get(latest) : undefined;
      if (latest && entry) return { inReplyTo: latest, entry, root: topic };
      return { inReplyTo: replyTo ?? topic, root: topic };
    }
    return replyTo ? { inReplyTo: replyTo, root: replyTo } : {};
  }

  private bodies(text: string, format: SendOptions['format']): { text: string; html?: string } {
    if (format === 'plain') return { text };
    if (format === 'html') return { text: htmlToText(text), html: text };
    return { text: markdownToPlainText(text), html: markdownToHtml(text) };
  }

  private async send(
    channelId: string,
    content: {
      text: string;
      html?: string;
      attachment?: NonNullable<OutgoingEmail['attachments']>[number];
    },
    options: SendOptions | undefined
  ): Promise<string> {
    const to = normalizeAddress(channelId);
    if (!isAddress(to)) {
      throw new Error(`[email] Unknown channel id "${channelId}": use the recipient's address`);
    }
    const thread = this.threadOf(to, options);
    const baseSubject =
      thread.entry?.subject ||
      this.config.subject ||
      `Message from ${this.config.name ?? this.address}`;
    const subject = thread.inReplyTo ? replySubject(baseSubject) : baseSubject;
    const references = thread.inReplyTo
      ? trimReferences([...(thread.entry?.references ?? []), thread.inReplyTo])
      : [];
    const messageId = `<${randomUUID()}@${domainOf(this.address)}>`;
    const transport = await this.transportOf();
    await transport.sendMail({
      from: this.config.name ? { name: this.config.name, address: this.address } : this.address,
      to,
      subject,
      text: content.text,
      ...(content.html && { html: content.html }),
      messageId,
      ...(thread.inReplyTo && { inReplyTo: thread.inReplyTo, references }),
      headers: {
        [EMAIL_LOOP_HEADER]: 'email',
        'Auto-Submitted': thread.inReplyTo ? 'auto-replied' : 'auto-generated',
      },
      ...(content.attachment && { attachments: [content.attachment] }),
    });
    this.remember(to, messageId, {
      subject: thread.entry?.subject || baseSubject,
      references: trimReferences([...references, messageId]),
      root: thread.root ?? messageId,
    });
    return messageId;
  }

  private transportOf(): Promise<EmailTransport> {
    const smtp = this.config.smtp;
    if ('transport' in smtp) return Promise.resolve(smtp.transport);
    this.transport ??= loadNodemailer()
      .then((nodemailer) => {
        const secure = smtp.secure ?? smtp.port === 465;
        return nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port ?? (secure ? 465 : 587),
          secure,
          ...(smtp.auth && { auth: smtp.auth }),
          ...smtp.options,
        });
      })
      .catch((error: unknown) => {
        this.transport = undefined;
        throw error;
      });
    return this.transport;
  }

  private listen(port: number, path: string, host?: string): Promise<void> {
    const listener = this.webhookListener();
    const server = createServer((req, res) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      if (pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      listener(req, res);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => {
        this.server = undefined;
        reject(error);
      };
      server.once('error', failed);
      server.listen(port, host, () => {
        server.off('error', failed);
        resolve();
      });
    });
  }
}

/** An email channel that answers mail in its thread. */
export function emailChannel(config: EmailChannelConfig): EmailChannel {
  return new EmailChannel(config);
}
