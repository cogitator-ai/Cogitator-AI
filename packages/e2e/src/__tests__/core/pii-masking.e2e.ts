import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, GoogleBackend, tool } from '@cogitator-ai/core';
import type { ChatRequest, LLMBackend } from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';
const EMAIL = 'maria.lopez@northwind-bank.io';
const PHONE = '+44 20 7946 0958';

/** The real Gemini backend, recording every request it is asked to send. */
function recordingGemini() {
  const requests: ChatRequest[] = [];
  const inner = new GoogleBackend({ apiKey: process.env.GOOGLE_API_KEY! });
  const backend: LLMBackend = {
    provider: 'google',
    chat: (request) => {
      requests.push(request);
      return inner.chat(request);
    },
    chatStream: (request) => {
      requests.push(request);
      return inner.chatStream(request);
    },
  };
  return { backend, requests };
}

describeGoogle('Core: PII masking', () => {
  let cogitator: Cogitator | undefined;
  const sent: Array<{ to: string; phone: string }> = [];

  const sendContact = tool({
    name: 'send_contact',
    description: 'Send the customer contact card to the sales team',
    parameters: z.object({
      to: z.string().describe('Customer email exactly as given'),
      phone: z.string().describe('Customer phone exactly as given'),
    }),
    execute: async (contact) => {
      sent.push(contact);
      return { delivered: true };
    },
  });

  const agent = new Agent({
    name: 'crm',
    model: MODEL,
    instructions:
      'Call send_contact once with the email and phone exactly as the user wrote them, then confirm in one sentence that repeats the email.',
    tools: [sendContact],
    temperature: 0,
  });

  afterEach(async () => {
    await cogitator?.close();
    sent.length = 0;
  });

  it(
    'keeps the values from the provider while the tool and the answer get them',
    { timeout: 120_000 },
    async () => {
      const { backend, requests } = recordingGemini();
      const detected: Array<Record<string, number>> = [];
      cogitator = new Cogitator({
        llm: { backends: { google: backend } },
        security: { pii: { onDetect: (counts) => detected.push(counts) } },
      });

      const result = await cogitator.run(agent, {
        input: `New lead: email ${EMAIL}, phone ${PHONE}. Send the contact card.`,
      });

      expect(sent).toEqual([{ to: EMAIL, phone: PHONE }]);
      expect(result.output).toContain(EMAIL);
      const seen = JSON.stringify(requests);
      expect(seen).not.toContain(EMAIL);
      expect(seen).not.toContain('7946');
      expect(seen).toContain('[EMAIL_1]');
      expect(detected[0]).toEqual({ email: 1, phone: 1 });
    }
  );

  it('streams the answer with the values restored', { timeout: 120_000 }, async () => {
    const { backend, requests } = recordingGemini();
    cogitator = new Cogitator({ llm: { backends: { google: backend } }, security: { pii: {} } });

    let streamed = '';
    const result = await cogitator.run(agent, {
      input: `Lead: ${EMAIL}, ${PHONE}. Send the contact card.`,
      stream: true,
      onToken: (token) => {
        streamed += token;
      },
    });

    expect(sent[0]?.to).toBe(EMAIL);
    expect(streamed).toContain(EMAIL);
    expect(streamed).not.toMatch(/\[EMAIL_\d+\]/);
    expect(result.output).toContain(EMAIL);
    expect(JSON.stringify(requests)).not.toContain(EMAIL);
  });

  it('leaves placeholders in the answer in redact mode', { timeout: 120_000 }, async () => {
    const { backend } = recordingGemini();
    cogitator = new Cogitator({
      llm: { backends: { google: backend } },
      security: { pii: { mode: 'redact' } },
    });

    const result = await cogitator.run(agent, {
      input: `Lead: ${EMAIL}, ${PHONE}. Send the contact card.`,
    });

    expect(sent[0]?.to).toBe('[EMAIL_1]');
    expect(result.output).not.toContain(EMAIL);
  });
});
