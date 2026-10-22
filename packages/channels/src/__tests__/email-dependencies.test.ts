import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('postal-mime');
  vi.doUnmock('nodemailer');
  vi.resetModules();
  vi.restoreAllMocks();
});

const transport = { sendMail: vi.fn().mockResolvedValue({}) };

describe('email channel without its optional packages', () => {
  it('fails start() with an install hint when postal-mime is missing and IMAP is set', async () => {
    vi.doMock('postal-mime', () => {
      throw new Error("Cannot find package 'postal-mime'");
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { EmailChannel } = await import('../channels/email/channel');
    const channel = new EmailChannel({
      address: 'bot@example.com',
      smtp: { transport },
      allowFrom: ['*'],
      imap: { host: 'imap.example.com', auth: { user: 'bot@example.com', pass: 'x' } },
    });
    await expect(channel.start()).rejects.toThrow('postal-mime is required');
    await expect(channel.start()).rejects.toThrow('pnpm add postal-mime');
  });

  it('fails start() with an install hint when nodemailer is missing for an SMTP server', async () => {
    vi.doMock('nodemailer', () => {
      throw new Error("Cannot find package 'nodemailer'");
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { EmailChannel } = await import('../channels/email/channel');
    const channel = new EmailChannel({
      address: 'bot@example.com',
      smtp: { host: 'smtp.example.com' },
      allowFrom: ['*'],
    });
    await expect(channel.start()).rejects.toThrow('nodemailer is required');
  });
});
