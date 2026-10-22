import type { Attachment, AttachmentType } from '@cogitator-ai/types';
import {
  decodeMimeWords,
  domainOf,
  headerOf,
  headersOf,
  messageIdOf,
  messageIdsOf,
  parseMailbox,
  type EmailHeaders,
  type EmailMailbox,
} from './address';
import { headerAuthentication, type SenderAuthentication } from './auth';
import { EmailDependencyError } from './errors';

/** An incoming email, whichever way it came: IMAP or a provider's webhook. */
export interface InboundEmail {
  /** The `Message-ID`, with its angle brackets */
  messageId?: string;
  inReplyTo?: string;
  /** The `References` ids, oldest first */
  references: string[];
  from?: EmailMailbox;
  subject: string;
  text?: string;
  html?: string;
  headers: EmailHeaders;
  attachments: Attachment[];
  /** What the receiving side found about the sender (DKIM, SPF, DMARC) */
  authentication: SenderAuthentication;
  /** The payload as it came, for `ChannelMessage.raw` */
  raw: unknown;
}

/** The structural part of `postal-mime` the channel uses, loaded on demand. */
interface PostalMimeHeader {
  key: string;
  value: string;
}

interface PostalMimeAttachment {
  filename: string | null;
  mimeType: string;
  disposition: string | null;
  related?: boolean;
  content: ArrayBuffer | Uint8Array | string;
}

interface PostalMimeEmail {
  headers: PostalMimeHeader[];
  subject?: string;
  text?: string;
  html?: string;
  attachments: PostalMimeAttachment[];
}

interface PostalMimeParser {
  parse(raw: string | Uint8Array): Promise<PostalMimeEmail>;
}

interface PostalMimeModule {
  default: new () => PostalMimeParser;
}

let postalMime: Promise<PostalMimeModule> | undefined;

/** Loads `postal-mime` once, failing with an install hint when it is missing. */
export function loadPostalMime(): Promise<PostalMimeModule> {
  postalMime ??= (import('postal-mime') as Promise<unknown> as Promise<PostalMimeModule>).catch(
    (error: unknown) => {
      postalMime = undefined;
      throw new EmailDependencyError(
        'postal-mime',
        'to read raw email (IMAP, Mailgun MIME mode, SendGrid raw mode)',
        { cause: error }
      );
    }
  );
  return postalMime;
}

/** The attachment type of a MIME type. */
export function attachmentTypeOf(mimeType: string): AttachmentType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** An attachment of an email, or nothing when it is larger than `maxBytes`. */
export function attachmentOf(
  content: Uint8Array,
  mimeType: string,
  filename: string | undefined,
  maxBytes: number
): Attachment | undefined {
  if (content.byteLength > maxBytes) {
    console.warn(
      `[email] Skipped the attachment ${filename ?? mimeType} of ${content.byteLength} bytes, over the limit of ${maxBytes}`
    );
    return undefined;
  }
  const type = mimeType.toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  return {
    type: attachmentTypeOf(type),
    buffer: content,
    mimeType: type,
    ...(filename && { filename }),
  };
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return Buffer.from(content, 'base64');
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/**
 * The thread fields, sender and subject every inbound email reads from its headers. A mail with
 * more than one `From` has no sender, since mail clients may show another one than is checked.
 */
export function envelopeOf(headers: EmailHeaders): {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from?: EmailMailbox;
  subject: string;
} {
  const messageId = messageIdOf(headerOf(headers, 'message-id'));
  const inReplyTo = messageIdOf(headerOf(headers, 'in-reply-to'));
  const fromHeaders = headersOf(headers, 'from');
  const from = fromHeaders.length === 1 ? parseMailbox(fromHeaders[0]) : undefined;
  return {
    ...(messageId && { messageId }),
    ...(inReplyTo && { inReplyTo }),
    references: messageIdsOf(headerOf(headers, 'references')),
    ...(from && { from }),
    subject: decodeMimeWords(headerOf(headers, 'subject') ?? '').trim(),
  };
}

export interface RawEmailOptions {
  maxAttachmentBytes: number;
  trustedAuthservIds?: readonly string[];
}

/** A raw RFC 5322 message, parsed with `postal-mime`. */
export async function parseRawEmail(
  raw: string | Uint8Array,
  options: RawEmailOptions
): Promise<InboundEmail> {
  const { default: PostalMime } = await loadPostalMime();
  const parsed = await new PostalMime().parse(raw);
  const headers: EmailHeaders = parsed.headers.map(({ key, value }) => [key.toLowerCase(), value]);
  const envelope = envelopeOf(headers);
  const attachments = parsed.attachments
    .filter((attachment) => !attachment.related)
    .map((attachment) =>
      attachmentOf(
        bytesOf(attachment.content),
        attachment.mimeType,
        attachment.filename ?? undefined,
        options.maxAttachmentBytes
      )
    )
    .filter((attachment): attachment is Attachment => attachment !== undefined);
  return {
    ...envelope,
    subject: parsed.subject?.trim() ?? envelope.subject,
    ...(parsed.text !== undefined && { text: parsed.text }),
    ...(parsed.html !== undefined && { html: parsed.html }),
    headers,
    attachments,
    authentication: headerAuthentication(headers, domainOf(envelope.from?.address ?? ''), {
      source: 'imap',
      ...(options.trustedAuthservIds && { trustedAuthservIds: options.trustedAuthservIds }),
    }),
    raw: parsed,
  };
}
