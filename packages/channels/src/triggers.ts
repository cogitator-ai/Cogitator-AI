/**
 * What the channels give the trigger manager of the core: the email channel's reading of a
 * provider's webhook for email triggers, and a sink that tells the owner of a routine in their
 * chat what it came to
 */

import type {
  Channel,
  EmailTriggerMail,
  InboxItem,
  NotificationSink,
  RoutineOwner,
  TriggerHttpRequest,
} from '@cogitator-ai/types';
import { EMAIL_DEFAULT_MAX_ATTACHMENT } from './channels/email/channel';
import type { RawEmailOptions } from './channels/email/mime';
import { readFormFields } from './channels/email/multipart';
import {
  bodyText,
  isForm,
  mailgunFormEmail,
  mailgunJsonEmail,
  postmarkEmail,
  requestHeader,
  sendgridEmail,
  type EmailProvider,
} from './channels/email/providers';
import { stripQuotedReply } from './channels/email/reply';

/** Options of {@link experimental_emailTriggerParser} */
export interface EmailTriggerParserOptions {
  /** Default 10 MB */
  maxAttachmentBytes?: number;
  /** The `Authentication-Results` servers whose verdict counts, as the email channel takes them */
  trustedAuthservIds?: readonly string[];
}

/**
 * Experimental. Reads a provider's inbound mail webhook as the email channel does (MIME, the
 * sender's DKIM, SPF and DMARC verdict, the quoted reply stripped) for an email trigger:
 * `{ kind: 'email', provider: 'mailgun', signingKey, parse: experimental_emailTriggerParser('mailgun') }`.
 * The trigger still checks the request's signature or secret before
 */
export function experimental_emailTriggerParser(
  provider: EmailProvider,
  options: EmailTriggerParserOptions = {}
): (request: TriggerHttpRequest) => Promise<EmailTriggerMail> {
  const parse: RawEmailOptions = {
    maxAttachmentBytes: options.maxAttachmentBytes ?? EMAIL_DEFAULT_MAX_ATTACHMENT,
    ...(options.trustedAuthservIds && { trustedAuthservIds: options.trustedAuthservIds }),
  };
  return async (request) => {
    const headers = request.headers as Record<string, string | string[] | undefined>;
    const contentType = requestHeader(headers, 'content-type') ?? '';
    const raw = request.rawBody;
    const email =
      provider === 'postmark'
        ? postmarkEmail(JSON.parse(bodyText(raw)) as unknown, parse)
        : provider === 'mailgun'
          ? isForm(contentType)
            ? await mailgunFormEmail(readFormFields(raw, contentType), parse)
            : await mailgunJsonEmail(JSON.parse(bodyText(raw)) as unknown, parse)
          : await sendgridEmail(readFormFields(raw, contentType), parse);
    const text = email.text ? stripQuotedReply(email.text) : undefined;
    return {
      ...(email.from && { from: email.from.address }),
      subject: email.subject,
      ...(text !== undefined && { text }),
      ...(email.messageId !== undefined && { messageId: email.messageId }),
      authentication: email.authentication,
      fields: {
        from: email.from,
        subject: email.subject,
        ...(email.messageId !== undefined && { messageId: email.messageId }),
        attachments: email.attachments.map((attachment) => ({
          type: attachment.type,
          ...(attachment.filename !== undefined && { filename: attachment.filename }),
          ...(attachment.mimeType !== undefined && { mimeType: attachment.mimeType }),
        })),
      },
    };
  };
}

/** Options of {@link experimental_channelSink} */
export interface ChannelSinkOptions {
  /** The chat items go to when their routine names no owner here: the owner's chat */
  channelId?: string;
  /** Which items to send, all by default */
  filter?: (item: InboxItem) => boolean;
  /** The text of an item, its title and summary by default */
  format?: (item: InboxItem) => string;
}

function ownerOf(item: InboxItem): RoutineOwner | undefined {
  const owner = item.metadata?.owner;
  return typeof owner === 'object' && owner !== null ? (owner as RoutineOwner) : undefined;
}

function defaultFormat(item: InboxItem): string {
  const mark =
    item.kind === 'failure' ? 'Failed' : item.kind === 'result' ? 'Done' : 'Waiting for you';
  return `${mark}: ${item.title}\n\n${item.summary}`.trim();
}

/**
 * Experimental. A sink of the inbox that tells the owner of a routine in their chat: an item goes
 * to its routine's `owner` when the owner is on this channel (`owner.channel` is the channel's
 * type or unset), else to `channelId`. Items with neither are not sent
 */
export function experimental_channelSink(
  channel: Channel,
  options: ChannelSinkOptions = {}
): NotificationSink {
  return {
    name: `channel ${channel.type}`,
    async notify(item) {
      if (options.filter && !options.filter(item)) return;
      const owner = ownerOf(item);
      const onThisChannel =
        owner !== undefined && (owner.channel === undefined || owner.channel === channel.type);
      const chat = onThisChannel ? (owner.channelId ?? owner.userId) : options.channelId;
      if (chat === undefined) return;
      await channel.sendText(chat, (options.format ?? defaultFormat)(item), {
        ...(onThisChannel && owner.topicId !== undefined && { topicId: owner.topicId }),
      });
    },
  };
}
