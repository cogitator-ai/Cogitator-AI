import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, isOllamaRunning } from './setup';

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
    let ollamaAvailable = false;

    beforeAll(async () => {
      ollamaAvailable = await isOllamaRunning();
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

    it('runs agent and returns output', async () => {
      if (!ollamaAvailable) return;

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

    it('streams agent response via SSE', async () => {
      if (!ollamaAvailable) return;

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
