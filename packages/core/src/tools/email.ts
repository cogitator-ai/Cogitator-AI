import { z } from 'zod';
import { tool } from '../tool';

const sendEmailParams = z.object({
  to: z
    .union([z.string().email(), z.array(z.string().email())])
    .describe('Recipient email address(es)'),
  subject: z.string().min(1).describe('Email subject'),
  body: z.string().min(1).describe('Email body (plain text or HTML)'),
  html: z.boolean().optional().describe('Treat body as HTML (default: false)'),
  from: z.string().email().optional().describe('Sender email (defaults to configured sender)'),
  replyTo: z.string().email().optional().describe('Reply-to email address'),
  cc: z
    .union([z.string().email(), z.array(z.string().email())])
    .optional()
    .describe('CC recipients'),
  bcc: z
    .union([z.string().email(), z.array(z.string().email())])
    .optional()
    .describe('BCC recipients'),
  provider: z
    .enum(['resend', 'smtp'])
    .optional()
    .describe('Email provider (auto-detects from available credentials)'),
});

export interface EmailResult {
  success: boolean;
  messageId?: string;
  provider: string;
  to: string[];
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function sendViaResend(params: {
  to: string[];
  subject: string;
  body: string;
  html: boolean;
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  apiKey: string;
}): Promise<EmailResult> {
  const { to, subject, body, html, from, replyTo, cc, bcc, apiKey } = params;

  const payload: Record<string, unknown> = {
    from: from ?? process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev',
    to,
    subject,
  };

  if (html) {
    payload.html = body;
  } else {
    payload.text = body;
  }

  if (replyTo) payload.reply_to = replyTo;
  if (cc && cc.length > 0) payload.cc = cc;
  if (bcc && bcc.length > 0) payload.bcc = bcc;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as { id: string };

  return {
    success: true,
    messageId: data.id,
    provider: 'resend',
    to,
  };
}

async function sendViaSMTP(params: {
  to: string[];
  subject: string;
  body: string;
  html: boolean;
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
}): Promise<EmailResult> {
  let nodemailer: typeof import('nodemailer');

  try {
    nodemailer = await import('nodemailer');
  } catch {
    throw new Error('nodemailer package not installed. Run: pnpm add nodemailer');
  }

  const { to, subject, body, html, from, replyTo, cc, bcc } = params;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error(
      'SMTP credentials not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.'
    );
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort ? parseInt(smtpPort, 10) : 587,
    secure: smtpPort === '465',
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  const mailOptions: Parameters<typeof transporter.sendMail>[0] = {
    from: from ?? process.env.SMTP_FROM ?? smtpUser,
    to: to.join(', '),
    subject,
  };

  if (html) {
    mailOptions.html = body;
  } else {
    mailOptions.text = body;
  }

  if (replyTo) mailOptions.replyTo = replyTo;
  if (cc && cc.length > 0) mailOptions.cc = cc.join(', ');
  if (bcc && bcc.length > 0) mailOptions.bcc = bcc.join(', ');

  const result = await transporter.sendMail(mailOptions);

  return {
    success: true,
    messageId: result.messageId,
    provider: 'smtp',
    to,
  };
}

function detectProvider(): 'resend' | 'smtp' | null {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER) return 'smtp';
  return null;
}

export const sendEmail = tool({
  name: 'send_email',
  description:
    'Send an email using Resend API or SMTP. Supports plain text and HTML, CC/BCC, and reply-to. Requires RESEND_API_KEY or SMTP_* environment variables.',
  parameters: sendEmailParams,
  category: 'communication',
  tags: ['email', 'send', 'notification', 'communication'],
  sideEffects: ['network', 'external'],
  execute: async ({
    to,
    subject,
    body,
    html = false,
    from,
    replyTo,
    cc,
    bcc,
    provider: requestedProvider,
  }) => {
    const toArray_ = toArray(to);
    const ccArray = toArray(cc);
    const bccArray = toArray(bcc);

    if (toArray_.length === 0) {
      return { error: 'At least one recipient required' };
    }

    const provider = requestedProvider ?? detectProvider();
    if (!provider) {
      return {
        error: 'No email provider configured. Set RESEND_API_KEY or SMTP_* environment variables.',
      };
    }

    try {
      switch (provider) {
        case 'resend': {
          const apiKey = process.env.RESEND_API_KEY;
          if (!apiKey) {
            return { error: 'RESEND_API_KEY not set' };
          }
          return await sendViaResend({
            to: toArray_,
            subject,
            body,
            html,
            from,
            replyTo,
            cc: ccArray,
            bcc: bccArray,
            apiKey,
          });
        }

        case 'smtp':
          return await sendViaSMTP({
            to: toArray_,
            subject,
            body,
            html,
            from,
            replyTo,
            cc: ccArray,
            bcc: bccArray,
          });

        default:
          return { error: `Unknown provider: ${provider as string}` };
      }
    } catch (err) {
      return { error: (err as Error).message, provider };
    }
  },
});
