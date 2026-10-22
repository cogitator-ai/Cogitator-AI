export { allowsSender, type EmailHeaders, type EmailMailbox } from './address';
export type { SenderAuthentication } from './auth';
export type { EmailImapConfig } from './imap';
export type { InboundEmail } from './mime';
export type { EmailProvider, EmailWebhookRequest, EmailWebhookResponse } from './providers';
export {
  EMAIL_LOOP_HEADER,
  EmailChannel,
  emailChannel,
  isAutomatedEmail,
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
