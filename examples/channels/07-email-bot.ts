import { Agent } from '@cogitator-ai/core';
import { Gateway, emailChannel } from '@cogitator-ai/channels';
import { createCogitator, DEFAULT_MODEL, requireEnv } from '../_shared/setup';

/**
 * An agent that answers email: it reads unread mail of a mailbox over IMAP
 * (IDLE tells it about new mail at once) and answers each in its own thread
 * over SMTP, with `Re:` subjects and `In-Reply-To` and `References` set, so
 * mail clients keep the conversation together. Every thread is a
 * conversation of its own, and quoted history is left out of what the agent
 * reads.
 *
 * Give the bot a mailbox of its own: it marks what it reads as read. For
 * Gmail turn on 2-step verification and create an app password, then use
 * imap.gmail.com and smtp.gmail.com. EMAIL_ALLOW_FROM lists who may write to
 * it (addresses or domains, comma-separated), since anyone can send mail and
 * a `From` address is easy to forge. EMAIL_TRUSTED_AUTHSERV_IDS names the
 * server whose Authentication-Results count (mx.google.com for Gmail): mail
 * whose DKIM, SPF or DMARC results there fail for the sender's domain is
 * dropped.
 *
 * Needs the transports: pnpm add imapflow postal-mime nodemailer
 */
requireEnv('GOOGLE_API_KEY');
const address = requireEnv('EMAIL_ADDRESS');
const allowFrom = requireEnv('EMAIL_ALLOW_FROM')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const trustedAuthservIds = process.env.EMAIL_TRUSTED_AUTHSERV_IDS?.split(',').map((id) =>
  id.trim()
);
const imapPassword = requireEnv('EMAIL_IMAP_PASSWORD');
const smtpPassword = process.env.EMAIL_SMTP_PASSWORD ?? imapPassword;

const email = emailChannel({
  address,
  name: 'Cogitator Assistant',
  allowFrom,
  ...(trustedAuthservIds && { trustedAuthservIds }),
  imap: {
    host: requireEnv('EMAIL_IMAP_HOST'),
    auth: { user: process.env.EMAIL_IMAP_USER ?? address, pass: imapPassword },
  },
  smtp: {
    host: requireEnv('EMAIL_SMTP_HOST'),
    port: Number(process.env.EMAIL_SMTP_PORT ?? 587),
    auth: { user: process.env.EMAIL_SMTP_USER ?? address, pass: smtpPassword },
  },
});

const agent = new Agent({
  name: 'email-assistant',
  model: DEFAULT_MODEL,
  instructions: `You answer email on behalf of a small team.
Write a short, friendly reply in plain language with Markdown where it helps.
Do not repeat the question back, and sign off as "Cogitator Assistant".`,
});

const cogitator = createCogitator({ memory: { adapter: 'memory' } });
const memory = await cogitator.getMemory();

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [email],
  ...(memory && { memory }),
  onError: (error, msg) => console.error(`Error answering ${msg.channelId}:`, error.message),
});

await gateway.start();
console.log(`\n  ${address} answers mail from ${allowFrom.join(', ')}. Ctrl+C stops.\n`);

process.on('SIGINT', async () => {
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});
