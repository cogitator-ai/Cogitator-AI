import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  CogitatorConfig,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';
import { toolOutputToDecision } from '../client/openai-adapter';

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});

let nextCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };

function answer(request: ChatRequest): ChatResponse {
  const results = request.messages.filter((m) => m.role === 'tool');
  if (results.length === 0) {
    return {
      id: 'r1',
      content: '',
      toolCalls: [nextCall],
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
  return {
    id: 'r2',
    content: `Result: ${results.map((m) => String(m.content)).join(' | ')}`,
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  };
}

const backend: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(async (request: ChatRequest) => answer(request)),
  chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const response = answer(request);
    if (response.content) yield { id: response.id, delta: { content: response.content } };
    if (response.toolCalls) yield { id: response.id, delta: { toolCalls: response.toolCalls } };
    yield {
      id: response.id,
      delta: {},
      finishReason: response.finishReason,
      usage: response.usage,
    };
  }),
};

const weatherFunction = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

const POLL = { pollIntervalMs: 10 };

async function startServer(config: CogitatorConfig = {}) {
  const cogitator = new Cogitator({ ...config, llm: { backends: { mock: backend } } });
  const server = new OpenAIServer(cogitator, {
    port: 0,
    host: '127.0.0.1',
    defaultModel: 'mock/m',
    tools: [refund],
  });
  await server.start();
  const client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
  return { cogitator, server, client };
}

describe('runs whose tools need approval', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await ctx.server.stop();
    await ctx.cogitator.close();
  });

  beforeEach(() => {
    refundImpl.mockClear();
    nextCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };
  });

  async function pausedRefund() {
    const assistant = await ctx.client.beta.assistants.create({ model: 'cogitator' });
    const thread = await ctx.client.beta.threads.create({
      messages: [{ role: 'user', content: 'Refund A-1' }],
    });
    const paused = await ctx.client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    return { thread, paused };
  }

  it('require action instead of completing without running the tool', async () => {
    const { paused } = await pausedRefund();

    expect(paused.status).toBe('requires_action');
    expect(paused.required_action?.submit_tool_outputs.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'refund', arguments: '{"order":"A-1"}' } },
    ]);
    expect(refundImpl).not.toHaveBeenCalled();
  });

  it('run the tool once the client approves it, then complete', async () => {
    const { thread, paused } = await pausedRefund();

    const done = await ctx.client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'c1', output: '{"approved":true}' }] },
      POLL
    );
    const messages = await ctx.client.beta.threads.messages.list(thread.id);

    expect(done.status).toBe('completed');
    expect(done.required_action).toBeNull();
    expect(refundImpl).toHaveBeenCalledTimes(1);
    expect(messages.data[0].content[0]).toMatchObject({
      text: { value: expect.stringContaining('refunded') },
    });
  });

  it('decline the tool with the reason the client gives', async () => {
    const { thread, paused } = await pausedRefund();

    const done = await ctx.client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'c1', output: 'too risky' }] },
      POLL
    );
    const messages = await ctx.client.beta.threads.messages.list(thread.id);

    expect(done.status).toBe('completed');
    expect(refundImpl).not.toHaveBeenCalled();
    expect(messages.data[0].content[0]).toMatchObject({
      text: { value: expect.stringContaining('too risky') },
    });
  });
});

describe('runs that call client-side functions', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ctx = await startServer({ limits: { defaultTimeout: 100 } });
  });

  afterAll(async () => {
    await ctx.server.stop();
    await ctx.cogitator.close();
  });

  beforeEach(() => {
    nextCall = { id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } };
  });

  async function pausedWeather(stream = false) {
    const assistant = await ctx.client.beta.assistants.create({
      model: 'cogitator',
      tools: [weatherFunction],
    });
    const thread = await ctx.client.beta.threads.create({
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
    });
    const paused = stream
      ? await ctx.client.beta.threads.runs
          .stream(thread.id, { assistant_id: assistant.id })
          .finalRun()
      : await ctx.client.beta.threads.runs.createAndPoll(
          thread.id,
          { assistant_id: assistant.id },
          POLL
        );
    return { thread, paused };
  }

  it('hand the call to the client and give the model its output', async () => {
    const { thread, paused } = await pausedWeather();
    expect(paused.status).toBe('requires_action');
    const call = paused.required_action!.submit_tool_outputs.tool_calls[0];
    expect(call).toMatchObject({ id: 'w1', function: { name: 'get_weather' } });

    const missing = await ctx.client.beta.threads.runs
      .submitToolOutputs(paused.id, { thread_id: thread.id, tool_outputs: [] })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OpenAI.BadRequestError);

    const done = await ctx.client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }] },
      POLL
    );
    const messages = await ctx.client.beta.threads.messages.list(thread.id);

    expect(done.status).toBe('completed');
    expect(messages.data[0].content[0]).toMatchObject({ text: { value: 'Result: "sunny"' } });
  });

  it('wait for the client longer than the run timeout', async () => {
    const { thread, paused } = await pausedWeather();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const done = await ctx.client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'w1', output: 'rain' }] },
      POLL
    );

    expect(done.last_error).toBeNull();
    expect(done.status).toBe('completed');
  });

  it('stream up to requires_action and continue with submitToolOutputsStream', async () => {
    const { thread, paused } = await pausedWeather(true);
    expect(paused.status).toBe('requires_action');

    const resumed = ctx.client.beta.threads.runs.submitToolOutputsStream(paused.id, {
      thread_id: thread.id,
      tool_outputs: [{ tool_call_id: 'w1', output: '42' }],
    });
    const run = await resumed.finalRun();
    const messages = await resumed.finalMessages();

    expect(run.status).toBe('completed');
    expect(messages[0].content[0]).toMatchObject({ text: { value: 'Result: "42"' } });
  });
});

describe('server tools decided by the operator policy', () => {
  it('never reach the client when guardrails.onToolApproval decides them', async () => {
    refundImpl.mockClear();
    nextCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };
    const onToolApproval = vi.fn(async () => false);
    const ctx = await startServer({
      llm: { defaultModel: 'mock/m' },
      guardrails: { enabled: false, onToolApproval },
    });
    const assistant = await ctx.client.beta.assistants.create({ model: 'cogitator' });
    const thread = await ctx.client.beta.threads.create({
      messages: [{ role: 'user', content: 'Refund A-1' }],
    });

    const run = await ctx.client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );

    expect(run.status).toBe('completed');
    expect(onToolApproval).toHaveBeenCalledTimes(1);
    expect(refundImpl).not.toHaveBeenCalled();
    await ctx.server.stop();
    await ctx.cogitator.close();
  });
});

describe('toolOutputToDecision', () => {
  it('approves only an explicit yes', () => {
    expect(toolOutputToDecision('{"approved":true}')).toEqual({ approved: true });
    expect(toolOutputToDecision(' Approve ')).toEqual({ approved: true });
    expect(toolOutputToDecision('true')).toEqual({ approved: true });
    expect(toolOutputToDecision('"approved"')).toEqual({ approved: true });
    expect(toolOutputToDecision('{"approved":false,"reason":"limit"}')).toEqual({
      approved: false,
      reason: 'limit',
    });
    expect(toolOutputToDecision('maybe later')).toEqual({
      approved: false,
      reason: 'maybe later',
    });
    expect(toolOutputToDecision('')).toEqual({ approved: false, reason: 'Declined by the client' });
    expect(toolOutputToDecision('{"approved":"yes"}')).toEqual({
      approved: false,
      reason: '{"approved":"yes"}',
    });
  });
});
