import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { StreamEventSchema, type StreamEvent } from '@cogitator-ai/server-shared';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from './setup';

export interface ServerFactory {
  start(cogitator: Cogitator, agents: Record<string, Agent>): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export function parseSSEEvents(body: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  const blocks = body.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | undefined;
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      }
    }

    if (dataLines.length === 0) continue;

    const raw = dataLines.join('\n');
    if (raw === '[DONE]') {
      events.push({ event, data: '[DONE]' });
      continue;
    }

    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      events.push({ event, data: raw });
    }
  }

  return events;
}

export function describeServerAdapter(name: string, factory: ServerFactory): void {
  describe(`Server Adapter: ${name}`, () => {
    let port: number;
    let cogitator: Cogitator;
    let ollamaSkip: string | null = null;

    beforeAll(async () => {
      ollamaSkip = await ollamaSkipReason();
      cogitator = createTestCogitator();
      const agent = createTestAgent();
      const result = await factory.start(cogitator, { TestAgent: agent });
      port = result.port;
    });

    afterAll(async () => {
      await factory.stop();
      await cogitator?.close();
    });

    it('health endpoint returns status', async () => {
      const res = await fetch(`http://localhost:${port}/cogitator/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('status');
    });

    it('lists registered agents', async () => {
      const res = await fetch(`http://localhost:${port}/cogitator/agents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.agents)).toBe(true);
      const names = body.agents.map((a: { name: string }) => a.name);
      expect(names).toContain('TestAgent');
    });

    it('runs agent and returns output', async ({ skip }) => {
      skip(ollamaSkip !== null, ollamaSkip ?? undefined);

      const res = await fetch(`http://localhost:${port}/cogitator/agents/TestAgent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'What is 2+2?' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.output).toBe('string');
      expect(body.output.length).toBeGreaterThan(0);
      expect(body.usage.totalTokens).toBeGreaterThan(0);
    });

    it('streams agent response via SSE', async ({ skip }) => {
      skip(ollamaSkip !== null, ollamaSkip ?? undefined);

      const res = await fetch(`http://localhost:${port}/cogitator/agents/TestAgent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Say hello' }),
      });

      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type') ?? '';
      expect(contentType).toContain('text/event-stream');

      const text = await res.text();
      const events = parseSSEEvents(text);
      expect(events.length).toBeGreaterThan(0);

      const hasContent = events.some((e) => {
        if (typeof e.data !== 'object' || e.data === null) return false;
        const d = e.data as Record<string, unknown>;
        return d.type === 'text-delta' || d.type === 'text-start';
      });
      expect(hasContent).toBe(true);
    });

    it('returns error for unknown agent', async () => {
      const res = await fetch(`http://localhost:${port}/cogitator/agents/NonExistent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test' }),
      });

      const body = await res.json();
      const isError = res.status === 404 || body.error !== undefined;
      expect(isError).toBe(true);
    });
  });
}

/** The events of an SSE body, each checked against the stream protocol schema */
function protocolEvents(body: string): StreamEvent[] {
  return parseSSEEvents(body)
    .filter((entry) => entry.data !== '[DONE]')
    .map((entry) => StreamEventSchema.parse(entry.data));
}

/**
 * A run paused for approval over `/stream`, then resumed over `/resume/stream`, on Gemini:
 * every event must match the stream protocol schema.
 */
export function describeResumeStream(name: string, factory: ServerFactory): void {
  const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

  describeGoogle(`Server Adapter: ${name} resume stream`, () => {
    let port: number;
    let cogitator: Cogitator;
    const refunded: Array<{ order: string; amount: number }> = [];

    const refund = tool({
      name: 'refund_order',
      description: 'Refund an order to the customer',
      parameters: z.object({ order: z.string(), amount: z.number() }),
      requiresApproval: true,
      execute: async (args) => {
        refunded.push(args);
        return { refunded: args.amount };
      },
    });

    const post = async (path: string, body: unknown) => {
      const res = await fetch(`http://localhost:${port}/cogitator/agents/support/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
      return protocolEvents(await res.text());
    };

    beforeAll(async () => {
      cogitator = new Cogitator({
        llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
        memory: { adapter: 'memory' },
      });
      const support = new Agent({
        name: 'support',
        model: 'google/gemini-3.5-flash-lite',
        instructions: 'Refund orders with refund_order when asked. Answer in one short sentence.',
        tools: [refund],
        temperature: 0,
      });
      ({ port } = await factory.start(cogitator, { support }));
    });

    afterAll(async () => {
      await factory.stop();
      await cogitator?.close();
    });

    it('pauses a stream for approval and streams the rest of the run once approved', async () => {
      const threadId = `resume-stream-${name.toLowerCase()}`;
      const paused = await post('stream', { input: 'Refund $340 for order A-1.', threadId });

      const approval = paused.find((event) => event.type === 'approval-required');
      expect(approval).toMatchObject({
        threadId,
        approvals: [{ toolName: 'refund_order', arguments: { order: 'A-1', amount: 340 } }],
      });
      expect(paused.at(-1)).toMatchObject({ type: 'finish', threadId, status: 'paused' });
      expect(refunded).toEqual([]);

      const resumed = await post('resume/stream', {
        threadId,
        defaultDecision: { approved: true },
      });

      expect(resumed[0]).toMatchObject({ type: 'start', threadId });
      expect(resumed.some((event) => event.type === 'tool-result')).toBe(true);
      expect(resumed.some((event) => event.type === 'text-delta')).toBe(true);
      expect(resumed.at(-1)).toMatchObject({ type: 'finish', threadId, status: 'completed' });
      expect(refunded).toEqual([{ order: 'A-1', amount: 340 }]);

      const again = await post('resume/stream', { threadId });
      expect(again.at(-1)).toMatchObject({ type: 'error', code: 'RUN_NOT_PAUSED' });
    }, 180_000);
  });
}
