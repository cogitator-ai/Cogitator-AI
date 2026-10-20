import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolResult,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
const LOG = `${'start '.repeat(2000)}${'end '.repeat(2000)}`;

function callsDump(seen: ChatRequest[]): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    seen.push(request);
    return request.messages.some((m) => m.role === 'tool')
      ? { id: 'r2', content: 'done', finishReason: 'stop', usage }
      : {
          id: 'r1',
          content: '',
          toolCalls: [{ id: 'c1', name: 'dump', arguments: {} }],
          finishReason: 'tool_calls',
          usage,
        };
  };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

function dumpAgent(maxResultLength?: number) {
  return new Agent({
    name: 'a',
    model: 'scripted/m',
    instructions: 'x',
    tools: [
      tool({
        name: 'dump',
        description: 'Dump a log',
        parameters: z.object({}),
        execute: async () => LOG,
        maxResultLength,
      }),
    ],
  });
}

async function runDump(limits: { maxToolResultLength?: number }, maxResultLength?: number) {
  const seen: ChatRequest[] = [];
  const results: ToolResult[] = [];
  const cog = new Cogitator({ llm: { backends: { scripted: callsDump(seen) } }, limits });
  await cog.run(dumpAgent(maxResultLength), {
    input: 'go',
    onToolResult: (result) => results.push(result),
  });
  await cog.close();
  const sent = seen[1]!.messages.find((m) => m.role === 'tool')!.content as string;
  return { sent, results };
}

describe('the length of a tool result the model reads', () => {
  it('follows limits.maxToolResultLength, while onToolResult gets the whole result', async () => {
    const { sent, results } = await runDump({ maxToolResultLength: 1000 });

    expect(sent.length).toBeLessThan(1100);
    expect(sent).toContain('characters of this tool result were left out');
    expect(sent.startsWith('"start')).toBe(true);
    expect(sent.endsWith('end "')).toBe(true);
    expect(results[0]?.result).toBe(LOG);
  });

  it("lets a tool's maxResultLength override the run limit", async () => {
    const { sent } = await runDump({ maxToolResultLength: 1000 }, 200);
    expect(sent.length).toBeLessThan(300);
  });

  it('sends the whole result when it fits', async () => {
    const { sent } = await runDump({});
    expect(sent).toBe(JSON.stringify(LOG));
  });
});
