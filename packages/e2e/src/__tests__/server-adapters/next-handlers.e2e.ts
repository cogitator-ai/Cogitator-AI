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
    const payloads = events
      .map((e) => e.data)
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null);
    const types = payloads.map((d) => d.type);

    expect(types[0]).toBe('start');
    expect(types).not.toContain('error');

    const streamed = payloads
      .filter((d) => d.type === 'text-delta')
      .map((d) => String(d.delta))
      .join('');
    expect(streamed.trim().length).toBeGreaterThan(0);

    const textStarts = payloads.filter((d) => d.type === 'text-start').map((d) => d.id);
    const textEnds = payloads.filter((d) => d.type === 'text-end').map((d) => d.id);
    expect(textEnds).toEqual(textStarts);

    const finish = payloads.find((d) => d.type === 'finish');
    expect(finish).toBeDefined();
    expect(typeof finish?.threadId).toBe('string');
    expect(events.at(-1)?.data).toBe('[DONE]');
  }, 60_000);

  it('createChatHandler rejects requests without a user message', async () => {
    const handler = createChatHandler(cogitator, agent);

    const response = await handler(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'assistant', content: 'hi' }] }),
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('No user message provided');
  });

  it('createAgentHandler rejects blank input before calling the model', async () => {
    const handler = createAgentHandler(cogitator, agent);

    const response = await handler(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '   ' }),
      })
    );

    expect(response.status).toBe(400);
  });

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
