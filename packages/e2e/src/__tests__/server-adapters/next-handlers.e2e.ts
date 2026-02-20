import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import { parseSSEEvents } from '../../helpers/server-test-utils';
import { createChatHandler, createAgentHandler } from '@cogitator-ai/next';
import type { Cogitator, Agent } from '@cogitator-ai/core';

describe('Next.js Handlers', () => {
  let cogitator: Cogitator;
  let agent: Agent;
  let ollamaAvailable = false;

  beforeAll(async () => {
    ollamaAvailable = await isOllamaRunning();
    cogitator = createTestCogitator();
    agent = createTestAgent();
  });

  afterAll(async () => {
    await cogitator?.close();
  });

  it('createAgentHandler returns agent output', async () => {
    if (!ollamaAvailable) return;

    const handler = createAgentHandler(cogitator, agent);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'What is 2+2?' }),
    });

    const response = await handler(request);

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(typeof body.output).toBe('string');
    expect(body.output.length).toBeGreaterThan(0);
    expect(body.usage.totalTokens).toBeGreaterThan(0);
  }, 60_000);

  it('createChatHandler streams SSE response', async () => {
    if (!ollamaAvailable) return;

    const handler = createChatHandler(cogitator, agent);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    });

    const response = await handler(request);

    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/event-stream');

    const text = await response.text();
    const events = parseSSEEvents(text);
    expect(events.length).toBeGreaterThan(0);

    const hasContent = events.some((e) => {
      if (typeof e.data !== 'object' || e.data === null) return false;
      const d = e.data as Record<string, unknown>;
      return d.type === 'text-delta' || d.type === 'text-start';
    });
    expect(hasContent).toBe(true);
  }, 60_000);

  it('handler returns error for invalid input', async () => {
    const handler = createAgentHandler(cogitator, agent);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });

    const response = await handler(request);

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBeDefined();
  });
});
