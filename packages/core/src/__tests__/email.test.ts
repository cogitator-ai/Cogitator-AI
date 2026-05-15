import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail } from '../tools/email';

const mockFetch = vi.fn();

describe('send_email tool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const ctx = { agentId: 'test', runId: 'run1', signal: new AbortController().signal };

  describe('provider detection', () => {
    it('returns error when no provider configured', async () => {
      const result = await sendEmail.execute(
        { to: 'test@example.com', subject: 'Test', body: 'Hello' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('No email provider configured');
    });

    it('auto-detects Resend when API key is set', async () => {
      vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_123' }),
      });

      const result = await sendEmail.execute(
        { to: 'test@example.com', subject: 'Test', body: 'Hello' },
        ctx
      );

      expect(mockFetch).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
      expect((result as { provider: string }).provider).toBe('resend');
    });
  });

  describe('Resend provider', () => {
    beforeEach(() => {
      vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
    });

    it('sends basic email', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_abc123' }),
      });

      const result = await sendEmail.execute(
        { to: 'recipient@example.com', subject: 'Hello', body: 'World' },
        ctx
      );

      expect(result).toMatchObject({
        success: true,
        messageId: 'msg_abc123',
        provider: 'resend',
        to: ['recipient@example.com'],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        to: ['recipient@example.com'],
        subject: 'Hello',
        text: 'World',
      });
    });

    it('sends HTML email', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_html' }),
      });

      await sendEmail.execute(
        { to: 'test@example.com', subject: 'HTML', body: '<h1>Hello</h1>', html: true },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toHaveProperty('html', '<h1>Hello</h1>');
      expect(body).not.toHaveProperty('text');
    });

    it('handles multiple recipients', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_multi' }),
      });

      const result = await sendEmail.execute(
        {
          to: ['user1@example.com', 'user2@example.com'],
          subject: 'Bulk',
          body: 'Message',
        },
        ctx
      );

      expect((result as { to: string[] }).to).toEqual(['user1@example.com', 'user2@example.com']);
    });

    it('includes CC and BCC', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_cc' }),
      });

      await sendEmail.execute(
        {
          to: 'main@example.com',
          subject: 'Test',
          body: 'Body',
          cc: 'cc@example.com',
          bcc: ['bcc1@example.com', 'bcc2@example.com'],
        },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.cc).toEqual(['cc@example.com']);
      expect(body.bcc).toEqual(['bcc1@example.com', 'bcc2@example.com']);
    });

    it('includes reply-to', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_reply' }),
      });

      await sendEmail.execute(
        {
          to: 'test@example.com',
          subject: 'Test',
          body: 'Body',
          replyTo: 'reply@example.com',
        },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.reply_to).toBe('reply@example.com');
    });

    it('uses custom from address', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_from' }),
      });

      await sendEmail.execute(
        {
          to: 'test@example.com',
          subject: 'Test',
          body: 'Body',
          from: 'sender@company.com',
        },
        ctx
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBe('sender@company.com');
    });

    it('uses RESEND_FROM_EMAIL env var as default', async () => {
      vi.stubEnv('RESEND_FROM_EMAIL', 'default@company.com');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_env' }),
      });

      await sendEmail.execute({ to: 'test@example.com', subject: 'Test', body: 'Body' }, ctx);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.from).toBe('default@company.com');
    });

    it('includes auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'msg_auth' }),
      });

      await sendEmail.execute({ to: 'test@example.com', subject: 'Test', body: 'Body' }, ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-resend-key',
          }),
        })
      );
    });

    it('handles API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await sendEmail.execute(
        { to: 'test@example.com', subject: 'Test', body: 'Body' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Resend API error');
    });

    it('honors the tool context abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const result = await sendEmail.execute(
        { to: 'test@example.com', subject: 'Test', body: 'Body' },
        { ...ctx, signal: controller.signal }
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('aborted');
    });
  });

  describe('explicit provider selection', () => {
    it('returns error when selected provider not configured', async () => {
      const result = await sendEmail.execute(
        { to: 'test@example.com', subject: 'Test', body: 'Body', provider: 'resend' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('RESEND_API_KEY not set');
    });

    it('returns error when SMTP selected but not configured', async () => {
      const result = await sendEmail.execute(
        { to: 'test@example.com', subject: 'Test', body: 'Body', provider: 'smtp' },
        ctx
      );

      expect(result).toHaveProperty('error');
    });
  });

  describe('validation', () => {
    it('returns error for empty recipients', async () => {
      vi.stubEnv('RESEND_API_KEY', 'key');

      const result = await sendEmail.execute({ to: [], subject: 'Test', body: 'Body' }, ctx);

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('At least one recipient required');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and description', () => {
      expect(sendEmail.name).toBe('send_email');
      expect(sendEmail.description).toContain('Send an email');
    });

    it('generates valid JSON schema', () => {
      const schema = sendEmail.toJSON();
      expect(schema.name).toBe('send_email');
      expect(schema.parameters.properties).toHaveProperty('to');
      expect(schema.parameters.properties).toHaveProperty('subject');
      expect(schema.parameters.properties).toHaveProperty('body');
      expect(schema.parameters.properties).toHaveProperty('provider');
    });
  });
});
