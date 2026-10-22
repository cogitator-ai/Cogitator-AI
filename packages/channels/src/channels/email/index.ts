export {
  allowsSender,
  decodeMimeWords,
  messageIdsOf,
  normalizeAddress,
  parseMailbox,
  type EmailHeaders,
  type EmailMailbox,
} from './address';
export {
  headerAuthentication,
  parseAuthenticationResults,
  verifyMailgunSignature,
  type SenderAuthentication,
} from './auth';
export { EMAIL_RECONNECT_MAX_DELAY, EMAIL_RECONNECT_MIN_DELAY, type EmailImapConfig } from './imap';
export type { InboundEmail } from './mime';
export type { EmailProvider, EmailWebhookRequest, EmailWebhookResponse } from './providers';
export { stripQuotedReply } from './reply';
export {
  EMAIL_DEFAULT_MAX_ATTACHMENT,
  EMAIL_DEFAULT_MAX_BODY,
  EMAIL_LOOP_HEADER,
  EmailChannel,
  emailChannel,
  isAutomatedEmail,
  MAILGUN_DEFAULT_MAX_AGE,
  replySubject,
  type EmailBasicAuth,
  type EmailChannelConfig,
  type EmailSenderAuthPolicy,
  type EmailSmtpConfig,
  type EmailSmtpServer,
  type EmailTransport,
  type EmailWebhookConfig,
  type MailgunWebhookConfig,
  type OutgoingEmail,
  type SecretWebhookConfig,
} from './channel';
