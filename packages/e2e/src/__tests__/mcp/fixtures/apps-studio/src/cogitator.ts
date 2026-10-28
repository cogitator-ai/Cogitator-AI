import { Agent, Cogitator } from '@cogitator-ai/core';
import { MCPClient } from '@cogitator-ai/mcp';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';

const url = process.env.MCP_APPS_URL;
if (!url) throw new Error('MCP_APPS_URL names the MCP server of the fixture');

const client = await MCPClient.connect({ transport: 'http', url });
const tools = await client.getTools();

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/** Calls show_chart for a user message, answers once its result is in */
function respond(request: ChatRequest): ChatResponse {
  if (request.messages.at(-1)?.role === 'tool') {
    return { id: 'answer', content: 'Here is the chart.', finishReason: 'stop', usage };
  }
  return {
    id: 'call',
    content: '',
    toolCalls: [{ id: 'call_chart', name: 'show_chart', arguments: { year: 2025 } }],
    finishReason: 'tool_calls',
    usage,
  };
}

const scripted: LLMBackend = {
  provider: 'openai',
  chat: async (request) => respond(request),
  chatStream: async function* (request): AsyncGenerator<ChatStreamChunk> {
    const answer = respond(request);
    if (answer.content) yield { id: answer.id, delta: { content: answer.content } };
    if (answer.toolCalls) yield { id: answer.id, delta: { toolCalls: answer.toolCalls } };
    yield { id: answer.id, delta: {}, finishReason: answer.finishReason, usage };
  },
};

export const cogitator = new Cogitator({
  llm: { defaultModel: 'scripted/m', backends: { scripted } },
});

export const agents = {
  sales: new Agent({
    name: 'sales',
    model: 'scripted/m',
    instructions: 'Show the sales.',
    tools,
  }),
};
