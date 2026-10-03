import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Message,
} from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { z } from 'zod';
import { PiiMasker, PiiMaskingBackend, PiiVault } from '../security/pii';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

const masker = new PiiMasker();
const types = (text: string) => masker.find(text).map((f) => f.type);

describe('PII detection', () => {
  it.each([
    ['Write to anna.smith+news@example.co.uk', ['email']],
    ['Call +1 415 555 0132 or (415) 555-0132', ['phone', 'phone']],
    ['Card 4111 1111 1111 1111, exp 12/29', ['credit_card']],
    ['IBAN DE89 3704 0044 0532 0130 00', ['iban']],
    ['SSN 123-45-6789', ['ssn']],
    ['Server at 192.168.1.10', ['ip_address']],
    [
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and AKIAIOSFODNN7EXAMPLE',
      ['api_key', 'api_key'],
    ],
  ])('finds personal data in %j', (text, expected) => {
    expect(types(text)).toEqual(expected);
  });

  it.each([
    'Order 1234567890 shipped on 2026-10-03 for $1,299.00',
    'Card 4111 1111 1111 1112 fails the checksum',
    'Version 999.1.1.1 is not an address',
    'IBAN DE00 3704 0044 0532 0130 00 has a wrong checksum',
  ])('leaves %j alone', (text) => {
    expect(types(text)).toEqual([]);
  });

  it('finds custom kinds and only the built-in kinds asked for', () => {
    const custom = new PiiMasker({
      detect: ['email'],
      custom: [{ type: 'customer_id', pattern: /CUS-\d{6}/ }],
    });

    expect(
      custom.find('CUS-123456 at a@b.io, card 4111 1111 1111 1111').map((f) => f.type)
    ).toEqual(['customer_id', 'email']);
  });

  it('gives a value the same placeholder every time and restores it', () => {
    const vault = new PiiVault();
    const masked = masker.mask('a@b.io wrote to c@d.io, then a@b.io again', vault);

    expect(masked).toBe('[EMAIL_1] wrote to [EMAIL_2], then [EMAIL_1] again');
    expect(vault.restore(masked)).toBe('a@b.io wrote to c@d.io, then a@b.io again');
    expect(vault.restore('[EMAIL_9] stays')).toBe('[EMAIL_9] stays');
  });
});

function scripted(respond: (request: ChatRequest) => ChatResponse, stream: string[] = []) {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push(request);
      return respond(request);
    }),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      requests.push(request);
      for (const piece of stream) yield { id: 's', delta: { content: piece } };
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const user = (content: string): Message => ({ role: 'user', content });

describe('PiiMaskingBackend', () => {
  it('sends placeholders and returns the real values', async () => {
    const onDetect = vi.fn();
    const { backend, requests } = scripted(() => ({
      id: 'r',
      content: 'I will email [EMAIL_1].',
      toolCalls: [{ id: 'c', name: 'send', arguments: { to: '[EMAIL_1]', cc: ['[PHONE_1]'] } }],
      finishReason: 'tool_calls',
      usage,
    }));

    const response = await new PiiMaskingBackend(backend, { onDetect }).chat({
      model: 'm',
      messages: [user('Email ann@example.com, call +44 20 7946 0958')],
    });

    expect(requests[0].messages[0].content).toBe('Email [EMAIL_1], call [PHONE_1]');
    expect(response.content).toBe('I will email ann@example.com.');
    expect(response.toolCalls?.[0].arguments).toEqual({
      to: 'ann@example.com',
      cc: ['+44 20 7946 0958'],
    });
    expect(onDetect).toHaveBeenCalledWith({ email: 1, phone: 1 });
  });

  it('keeps placeholders in redact mode', async () => {
    const { backend } = scripted(() => ({
      id: 'r',
      content: 'Noted [EMAIL_1].',
      finishReason: 'stop',
      usage,
    }));

    const response = await new PiiMaskingBackend(backend, { mode: 'redact' }).chat({
      model: 'm',
      messages: [user('ann@example.com')],
    });

    expect(response.content).toBe('Noted [EMAIL_1].');
  });

  it('restores placeholders split across stream chunks', async () => {
    const { backend } = scripted(
      () => ({ id: 'r', content: '', finishReason: 'stop', usage }),
      ['Mail sent to [EM', 'AIL_1', '] and [', 'nothing else]']
    );

    let text = '';
    for await (const chunk of new PiiMaskingBackend(backend, {}).chatStream({
      model: 'm',
      messages: [user('ann@example.com')],
    })) {
      text += chunk.delta.content ?? '';
    }

    expect(text).toBe('Mail sent to ann@example.com and [nothing else]');
  });
});

describe('PII in agent runs', () => {
  const sent: string[] = [];
  const sendEmail = tool({
    name: 'send_email',
    description: 'Send an email',
    parameters: z.object({ to: z.string(), body: z.string() }),
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  });
  const agent = new Agent({
    name: 'mailer',
    model: 'mock/m',
    instructions: 'Send emails.',
    tools: [sendEmail],
  });

  function mailerBackend() {
    return scripted((request) =>
      request.messages.some((m) => m.role === 'tool')
        ? {
            id: 'r2',
            content: `Done: ${String(request.messages.at(-1)?.content)}`,
            finishReason: 'stop',
            usage,
          }
        : {
            id: 'r1',
            content: '',
            toolCalls: [
              { id: 'c1', name: 'send_email', arguments: { to: '[EMAIL_1]', body: 'Hi' } },
            ],
            finishReason: 'tool_calls',
            usage,
          }
    );
  }

  it('never shows the provider the values while tools and the user get them', async () => {
    sent.length = 0;
    const { backend, requests } = mailerBackend();
    const cog = new Cogitator({ llm: { backends: { mock: backend } }, security: { pii: {} } });

    const result = await cog.run(agent, { input: 'Email bob@corp.io a hello' });

    expect(sent).toEqual(['bob@corp.io']);
    expect(result.output).toBe('Done: "sent to bob@corp.io"');
    expect(JSON.stringify(requests)).not.toContain('bob@corp.io');
    expect(requests[1].messages.at(-1)?.content).toBe('"sent to [EMAIL_1]"');
    await cog.close();
  });

  it('refuses input with personal data in block mode', async () => {
    const { backend } = mailerBackend();
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      security: { pii: { mode: 'block' } },
    });

    await expect(cog.run(agent, { input: 'Email bob@corp.io' })).rejects.toMatchObject({
      code: ErrorCode.PII_DETECTED,
      details: { types: ['email'] },
    });
    expect(backend.chat).not.toHaveBeenCalled();
    await cog.close();
  });
});
