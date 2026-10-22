import { z } from 'zod';
import type { Attachment } from '@cogitator-ai/types';
import {
  alignedDomains,
  domainOf,
  headersOf,
  messageIdOf,
  messageIdsOf,
  isAddress,
  normalizeAddress,
  parseHeaderBlock,
  parseMailbox,
  type EmailHeaders,
  type EmailMailbox,
} from './address';
import { combineAuthentication, headerAuthentication, type SenderAuthentication } from './auth';
import type { FormFields } from './multipart';
import {
  attachmentOf,
  envelopeOf,
  parseRawEmail,
  type InboundEmail,
  type RawEmailOptions,
} from './mime';

/** The email providers whose inbound webhooks the channel reads. */
export type EmailProvider = 'mailgun' | 'postmark' | 'sendgrid';

/** A webhook request, as any HTTP server hands it over. */
export interface EmailWebhookRequest {
  method: string;
  /** The query string parameters, where a secret token may be */
  query?: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** The body exactly as received, which Mailgun's signature covers in JSON mode */
  rawBody?: string | Uint8Array;
}

export interface EmailWebhookResponse {
  status: number;
  body: string;
}

/** A header by its name in any letter case, as HTTP header names are. */
export function requestHeader(
  headers: EmailWebhookRequest['headers'],
  name: string
): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export function bodyText(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
}

export function isForm(contentType: string | undefined): boolean {
  return /^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(contentType ?? '');
}

/** The attachment a form part holds, typed by `info` where the provider lists it. */
function formAttachment(
  fields: FormFields,
  name: string,
  maxBytes: number,
  info?: { filename?: string; type?: string }
): Attachment | undefined {
  const part = fields.part(name);
  if (!part) return undefined;
  return attachmentOf(
    new Uint8Array(part.data),
    info?.type ?? part.contentType ?? 'application/octet-stream',
    info?.filename ?? part.filename,
    maxBytes
  );
}

/** A stand-in `Message-ID` for a message that has none, stable for the same message. */
function fallbackMessageId(provider: EmailProvider, id: string): string {
  return `<${id.replace(/[<>\s]/g, '')}@${provider}.invalid>`;
}

const HeaderPairsSchema = z.array(z.tuple([z.string(), z.unknown()]).rest(z.unknown()));

function headerPairs(value: unknown): EmailHeaders {
  const parsed = HeaderPairsSchema.safeParse(typeof value === 'string' ? safeJson(value) : value);
  if (!parsed.success) return [];
  return parsed.data.map(([name, headerValue]) => [name.toLowerCase(), String(headerValue)]);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The domain of each `DKIM-Signature` header, by its `d=` tag. */
function signingDomains(headers: EmailHeaders): string[] {
  return headersOf(headers, 'dkim-signature')
    .map((value) => /(?:^|;)\s*d\s*=\s*([^;\s]+)/i.exec(value)?.[1]?.toLowerCase())
    .filter((domain): domain is string => !!domain);
}

/**
 * The value of a header the provider adds, or `fail` when the message carries more than one copy:
 * the sender may have added one, and which is the provider's own cannot be told.
 */
function providerHeader(headers: EmailHeaders, name: string): string | 'duplicate' | undefined {
  const values = headersOf(headers, name);
  if (values.length > 1) return 'duplicate';
  return values[0]?.trim().toLowerCase();
}

/**
 * Mailgun's verdict, from the headers Mailgun adds to a received message: `X-Mailgun-Spf` for the
 * envelope sender and `X-Mailgun-Dkim-Check-Result`. A message with more than one copy of either
 * fails, since the sender may have added one. Mailgun does not say which signature its DKIM
 * result is for, so a DKIM pass counts only when the message carries exactly one signature and
 * it is for the author's domain.
 */
export function mailgunAuthentication(
  headers: EmailHeaders,
  fromDomain: string,
  envelopeSender: string | undefined
): SenderAuthentication {
  const spf = providerHeader(headers, 'x-mailgun-spf');
  const dkim = providerHeader(headers, 'x-mailgun-dkim-check-result');
  if (spf === 'duplicate' || dkim === 'duplicate') return 'fail';
  const verdicts: SenderAuthentication[] = [];
  if (spf) {
    const senderDomain = envelopeSender ? domainOf(envelopeSender) : '';
    if (spf === 'pass' && alignedDomains(senderDomain, fromDomain)) verdicts.push('pass');
    else if (spf !== 'neutral' && spf !== 'none') verdicts.push('fail');
  }
  if (dkim) {
    const domains = signingDomains(headers);
    if (dkim === 'pass' && domains.length === 1 && alignedDomains(domains[0], fromDomain)) {
      verdicts.push('pass');
    } else verdicts.push('fail');
  }
  return combineAuthentication(...verdicts);
}

interface MailgunFields {
  get(name: string): string | undefined;
  headers: EmailHeaders;
  attachments: Attachment[];
}

async function mailgunEmailOf(
  fields: MailgunFields,
  raw: unknown,
  options: RawEmailOptions
): Promise<InboundEmail> {
  const mime = fields.get('body-mime');
  const sender = fields.get('sender');
  if (mime) {
    const parsed = await parseRawEmail(mime, options);
    const headers = fields.headers.length ? fields.headers : parsed.headers;
    return {
      ...parsed,
      authentication: mailgunAuthentication(headers, domainOf(parsed.from?.address ?? ''), sender),
      raw,
    };
  }
  const headers = fields.headers;
  const envelope = envelopeOf(headers);
  const from = envelope.from ?? parseMailbox(fields.get('from') ?? fields.get('From'));
  const messageId =
    envelope.messageId ?? messageIdOf(fields.get('Message-Id') ?? fields.get('message-id'));
  const inReplyTo = envelope.inReplyTo ?? messageIdOf(fields.get('In-Reply-To'));
  const references = envelope.references.length
    ? envelope.references
    : messageIdsOf(fields.get('References'));
  const text = fields.get('body-plain');
  const html = fields.get('body-html');
  return {
    ...(messageId && { messageId }),
    ...(inReplyTo && { inReplyTo }),
    references,
    ...(from && { from }),
    subject: envelope.subject || (fields.get('subject') ?? '').trim(),
    ...(text !== undefined && { text }),
    ...(html !== undefined && { html }),
    headers,
    attachments: fields.attachments,
    authentication: mailgunAuthentication(headers, domainOf(from?.address ?? ''), sender),
    raw,
  };
}

/** A Mailgun route's form post (`forward()` to a URL), as an inbound email. */
export async function mailgunFormEmail(
  fields: FormFields,
  options: RawEmailOptions
): Promise<InboundEmail> {
  const count = Number(fields.text('attachment-count') ?? 0);
  const attachments: Attachment[] = [];
  for (let i = 1; i <= Math.min(count, 100); i++) {
    const attachment = formAttachment(fields, `attachment-${i}`, options.maxAttachmentBytes);
    if (attachment) attachments.push(attachment);
  }
  return mailgunEmailOf(
    {
      get: (name) => fields.text(name),
      headers: headerPairs(fields.text('message-headers')),
      attachments,
    },
    fields.entries(),
    options
  );
}

const MailgunJsonSchema = z
  .object({
    'message-headers': z.unknown().optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().optional(),
          'content-type': z.string().optional(),
          content: z.string(),
        })
      )
      .optional(),
  })
  .catchall(z.unknown());

/** A Mailgun route's JSON post (a `forward()` URL ending in `json`), as an inbound email. */
export async function mailgunJsonEmail(
  payload: unknown,
  options: RawEmailOptions
): Promise<InboundEmail> {
  const body = MailgunJsonSchema.parse(payload);
  const attachments = (body.attachments ?? [])
    .map((attachment) =>
      attachmentOf(
        Buffer.from(attachment.content, 'base64'),
        attachment['content-type'] ?? 'application/octet-stream',
        attachment.filename,
        options.maxAttachmentBytes
      )
    )
    .filter((attachment): attachment is Attachment => attachment !== undefined);
  return mailgunEmailOf(
    {
      get: (name) => {
        const value = body[name];
        return typeof value === 'string' ? value : undefined;
      },
      headers: headerPairs(body['message-headers']),
      attachments,
    },
    payload,
    options
  );
}

const PostmarkSchema = z.object({
  MessageID: z.string().optional(),
  From: z.string().optional(),
  FromName: z.string().optional(),
  FromFull: z.object({ Email: z.string(), Name: z.string().optional() }).optional(),
  Subject: z.string().optional(),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).optional(),
  Attachments: z
    .array(
      z.object({
        Name: z.string().optional(),
        Content: z.string(),
        ContentType: z.string().optional(),
      })
    )
    .optional(),
});

/** Postmark's inbound webhook JSON, as an inbound email. */
export function postmarkEmail(payload: unknown, options: RawEmailOptions): InboundEmail {
  const body = PostmarkSchema.parse(payload);
  const headers: EmailHeaders = (body.Headers ?? []).map(({ Name, Value }) => [
    Name.toLowerCase(),
    Value,
  ]);
  const envelope = envelopeOf(headers);
  const fromAddress = normalizeAddress(body.FromFull?.Email ?? body.From ?? '');
  const fromName = (body.FromFull?.Name || body.FromName || '').trim();
  const from: EmailMailbox | undefined = isAddress(fromAddress)
    ? { address: fromAddress, ...(fromName && { name: fromName }) }
    : envelope.from;
  const messageId =
    envelope.messageId ??
    (body.MessageID ? fallbackMessageId('postmark', body.MessageID) : undefined);
  const attachments = (body.Attachments ?? [])
    .map((attachment) =>
      attachmentOf(
        Buffer.from(attachment.Content, 'base64'),
        attachment.ContentType ?? 'application/octet-stream',
        attachment.Name,
        options.maxAttachmentBytes
      )
    )
    .filter((attachment): attachment is Attachment => attachment !== undefined);
  return {
    ...envelope,
    ...(messageId && { messageId }),
    ...(from && { from }),
    subject: (body.Subject ?? envelope.subject).trim(),
    ...(body.TextBody !== undefined && { text: body.TextBody }),
    ...(body.HtmlBody !== undefined && { html: body.HtmlBody }),
    headers,
    attachments,
    authentication: headerAuthentication(headers, domainOf(from?.address ?? ''), {
      source: 'postmark',
      ...(options.trustedAuthservIds && { trustedAuthservIds: options.trustedAuthservIds }),
    }),
    raw: payload,
  };
}

const AttachmentInfoSchema = z.record(
  z.string(),
  z.object({ filename: z.string().optional(), type: z.string().optional() })
);

/**
 * SendGrid's verdict: the `dkim` field (`{@example.com : pass}`, one entry per signature) and
 * the `SPF` field for the envelope sender.
 */
export function sendgridAuthentication(
  dkim: string | undefined,
  spf: string | undefined,
  envelopeFrom: string | undefined,
  fromDomain: string
): SenderAuthentication {
  const verdicts: SenderAuthentication[] = [];
  if (dkim) {
    const entries = [...dkim.matchAll(/@?((?:[a-z0-9-]+\.)+[a-z]{2,})\s*:\s*([a-z]+)/gi)];
    if (
      entries.some(
        ([, domain, result]) =>
          result.toLowerCase() === 'pass' && alignedDomains(domain, fromDomain)
      )
    ) {
      verdicts.push('pass');
    } else if (entries.length > 0) verdicts.push('fail');
  }
  const spfResult = spf?.trim().toLowerCase();
  if (spfResult) {
    if (
      spfResult === 'pass' &&
      envelopeFrom &&
      alignedDomains(domainOf(envelopeFrom), fromDomain)
    ) {
      verdicts.push('pass');
    } else if (spfResult !== 'neutral' && spfResult !== 'none') verdicts.push('fail');
  }
  return combineAuthentication(...verdicts);
}

const CharsetsSchema = z.record(z.string(), z.string());

/**
 * A SendGrid Inbound Parse post (parsed, or raw with the whole message in `email`). SendGrid
 * posts each parsed field in the character set it was written in and names them in `charsets`,
 * so the fields are decoded by it.
 */
export async function sendgridEmail(
  fields: FormFields,
  options: RawEmailOptions
): Promise<InboundEmail> {
  const charsets = CharsetsSchema.safeParse(safeJson(fields.text('charsets') ?? ''));
  const text = (name: string) =>
    fields.text(name, charsets.success ? charsets.data[name] : undefined);
  const envelopeFrom = z
    .object({ from: z.string().optional() })
    .safeParse(safeJson(text('envelope') ?? ''));
  const sender = envelopeFrom.success ? envelopeFrom.data.from : undefined;
  const raw = fields.entries();
  const authenticate = (fromAddress: string | undefined) =>
    sendgridAuthentication(text('dkim'), text('SPF'), sender, domainOf(fromAddress ?? ''));
  const mime = fields.part('email');
  if (mime && mime.data.length > 0) {
    const parsed = await parseRawEmail(new Uint8Array(mime.data), options);
    return { ...parsed, authentication: authenticate(parsed.from?.address), raw };
  }
  const headers = parseHeaderBlock(text('headers') ?? '');
  const envelope = envelopeOf(headers);
  const from = envelope.from ?? parseMailbox(text('from'));
  const info = AttachmentInfoSchema.safeParse(safeJson(text('attachment-info') ?? ''));
  const count = Number(text('attachments') ?? 0);
  const attachments: Attachment[] = [];
  for (let i = 1; i <= Math.min(count, 100); i++) {
    const name = `attachment${i}`;
    const attachment = formAttachment(
      fields,
      name,
      options.maxAttachmentBytes,
      info.success ? info.data[name] : undefined
    );
    if (attachment) attachments.push(attachment);
  }
  const body = text('text');
  const html = text('html');
  return {
    ...envelope,
    ...(from && { from }),
    subject: envelope.subject || (text('subject') ?? '').trim(),
    ...(body !== undefined && { text: body }),
    ...(html !== undefined && { html }),
    headers,
    attachments,
    authentication: authenticate(from?.address),
    raw,
  };
}
