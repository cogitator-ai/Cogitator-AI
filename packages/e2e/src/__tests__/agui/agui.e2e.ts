import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { z } from 'zod';
import { EventType, HttpAgent, type AgentSubscriber, type BaseEvent } from '@ag-ui/client';
import { Agent, Cogitator, agentAsTool, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import { CogitatorServer } from '@cogitator-ai/express';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const ollamaSkip = await ollamaSkipReason();

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/**
 * A model that answers by the last message it reads: the lead delegates to the charts agent and
 * asks the user for a size, the charts agent draws, every tool result gets a short answer
 */
function scriptedModel(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    const last = request.messages.at(-1);
    const system = request.messages.find((message) => message.role === 'system');
    const isCharts = typeof system?.content === 'string' && system.content.includes('Draw charts');
    const call = (id: string, name: string, args: Record<string, unknown>): ChatResponse => ({
      id,
      content: '',
      toolCalls: [{ id, name, arguments: args } satisfies ToolCall],
      finishReason: 'tool_calls',
      usage,
    });
    if (last?.role === 'user' && isCharts) return call('call_chart', 'chart', {});
    if (last?.role === 'user') return call('call_delegate', 'charts', { task: 'Draw sales' });
    if (last?.role === 'tool' && isCharts) {
      return { id: 'r', content: 'Chart drawn.', finishReason: 'stop', usage };
    }
    const results = request.messages.filter((message) => message.role === 'tool').length;
    if (results === 1) return call('call_size', 'ask_size', {});
    return { id: 'r', content: 'All done, size noted.', finishReason: 'stop', usage };
  };
  return {
    provider: 'openai',
    chat: async (request) => respond(request),
    chatStream: async function* (request): AsyncGenerator<ChatStreamChunk> {
      const answer = respond(request);
      if (answer.content) yield { id: answer.id, delta: { content: answer.content } };
      if (answer.toolCalls) yield { id: answer.id, delta: { toolCalls: answer.toolCalls } };
      yield { id: answer.id, delta: {}, finishReason: answer.finishReason, usage };
    },
  };
}

async function listen(
  cogitator: Cogitator,
  agent: Agent
): Promise<{ server: Server; url: string }> {
  const app = express();
  const cogitatorServer = new CogitatorServer({
    app,
    cogitator,
    agents: { assistant: agent },
    config: { basePath: '/cogitator', enableSwagger: false },
  });
  await cogitatorServer.init();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/cogitator/agents/assistant/agui` };
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function recorder(): { events: BaseEvent[]; subscriber: AgentSubscriber } {
  const events: BaseEvent[] = [];
  return { events, subscriber: { onEvent: ({ event }) => void events.push(event) } };
}

describe('AG-UI endpoint with a scripted model', () => {
  let cogitator: Cogitator;
  let server: Server | undefined;
  let url = '';

  beforeAll(async () => {
    cogitator = new Cogitator({
      llm: { backends: { mock: scriptedModel() }, defaultModel: 'mock/m' },
      memory: { adapter: 'memory' },
    });
    const chart = tool({
      name: 'chart',
      description: 'Draws a chart',
      parameters: z.object({}),
      execute: async (_args, context) => {
        const id = context.data?.({ name: 'chart', data: { points: [1] } });
        context.data?.({ id, name: 'chart', data: { points: [1, 2, 3] } });
        return 'drawn';
      },
    });
    const charts = new Agent({
      name: 'charts',
      model: 'mock/m',
      instructions: 'Draw charts.',
      tools: [chart],
    });
    const askSize = tool({
      name: 'ask_size',
      description: 'Asks the user for a size',
      parameters: z.object({}),
      execute: async (_args, context) => {
        const size = await context.interrupt?.({
          reason: 'pick_size',
          message: 'Which size?',
          responseSchema: z.enum(['S', 'M', 'L']),
        });
        const current = context.state?.get();
        const cart =
          typeof current === 'object' && current !== null && 'cart' in current
            ? (current.cart as string[])
            : [];
        context.state?.set({ cart: [...cart, `shirt ${String(size)}`] });
        return { size };
      },
    });
    const lead = new Agent({
      name: 'lead',
      model: 'mock/m',
      instructions: 'Lead the order.',
      tools: [agentAsTool(cogitator, charts, { name: 'charts', description: 'Draws' }), askSize],
    });
    ({ server, url } = await listen(cogitator, lead));
  });

  afterAll(async () => {
    await close(server);
    await cogitator?.close();
  });

  it('streams a subagent, data parts, a question, then resumes with the answer and state', async () => {
    const agent = new HttpAgent({ url, threadId: 'agui-e2e-1', initialState: { cart: [] } });
    agent.addMessage({ id: 'u1', role: 'user', content: 'Order a shirt and chart the sales' });
    const first = recorder();

    await agent.runAgent({}, first.subscriber);

    const types = first.events.map((event) => event.type);
    expect(types[0]).toBe('RUN_STARTED');
    expect(types).toContain('SUBAGENT_STARTED');
    expect(types).toContain('SUBAGENT_FINISHED');
    expect(types).toContain('ACTIVITY_SNAPSHOT');
    expect(types).toContain('ACTIVITY_DELTA');
    const subagent = first.events.find((event) => event.type === EventType.SUBAGENT_STARTED);
    expect(subagent).toMatchObject({ name: 'charts', parentToolCallId: 'call_delegate' });
    const finished = first.events.at(-1);
    expect(finished).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'interrupt', interrupts: [{ reason: 'pick_size', message: 'Which size?' }] },
    });
    expect(agent.pendingInterrupts).toHaveLength(1);
    const activity = agent.messages.find((message) => message.role === 'activity');
    expect(activity && 'content' in activity && activity.content).toEqual({ points: [1, 2, 3] });

    const second = recorder();
    const interruptId = agent.pendingInterrupts[0]?.id ?? '';
    await agent.runAgent(
      { resume: [{ interruptId, status: 'resolved', payload: 'M' }] },
      second.subscriber
    );

    expect(second.events.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: { type: 'success' },
    });
    expect(second.events.map((event) => event.type)).toContain('STATE_DELTA');
    expect(agent.state).toEqual({ cart: ['shirt M'] });
    expect(agent.pendingInterrupts).toEqual([]);
    const answer = agent.messages.filter((message) => message.role === 'assistant').at(-1);
    expect(answer && 'content' in answer && answer.content).toBe('All done, size noted.');
    const sizeResult = agent.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'call_size'
    );
    expect(sizeResult && 'content' in sizeResult && sizeResult.content).toBe('{"size":"M"}');
  });

  it('refuses a request without a user message last', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 't', runId: 'r', messages: [] }),
    });
    expect(response.status).toBe(400);
  });
});

describe.skipIf(ollamaSkip !== null)('AG-UI endpoint on Ollama', () => {
  let cogitator: Cogitator;
  let server: Server | undefined;
  let url = '';

  beforeAll(async () => {
    cogitator = createTestCogitator({ memory: true });
    ({ server, url } = await listen(
      cogitator,
      createTestAgent({ name: 'assistant', instructions: 'Answer in one short sentence.' })
    ));
  });

  afterAll(async () => {
    await close(server);
    await cogitator?.close();
  });

  it('streams a real answer an AG-UI client turns into a message', async () => {
    const agent = new HttpAgent({ url, threadId: 'agui-ollama-1' });
    agent.addMessage({ id: 'u1', role: 'user', content: 'Say hello.' });
    const run = recorder();

    const result = await agent.runAgent({}, run.subscriber);

    expect(run.events[0]?.type).toBe('RUN_STARTED');
    expect(run.events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
    expect(run.events.map((event) => event.type)).toContain('TEXT_MESSAGE_CONTENT');
    const answer = result.newMessages.find((message) => message.role === 'assistant');
    expect(answer && 'content' in answer ? answer.content : '').not.toBe('');
  });
});
