import { describe, it, expect, vi } from 'vitest';
import type { ChatResponse, ChatStreamChunk, LLMBackend, ToolCall } from '@cogitator-ai/types';
import { z } from 'zod';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { normalizeTurn } from '../llm/turn';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

function turn(partial: Partial<ChatResponse>): ChatResponse {
  return { id: 'r', content: '', finishReason: 'stop', usage, ...partial };
}

function scripted(turns: ChatResponse[]): LLMBackend {
  let index = 0;
  return {
    provider: 'openai',
    chat: vi.fn(async () => turns[Math.min(index++, turns.length - 1)]),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      const next = turns[Math.min(index++, turns.length - 1)];
      if (next.content) yield { id: next.id, delta: { content: next.content } };
      yield {
        id: next.id,
        delta: { toolCalls: next.toolCalls },
        finishReason: next.finishReason,
        ...(next.finishMessage && { finishMessage: next.finishMessage }),
        usage: next.usage,
      };
    }),
  };
}

function purgeAgent(purged: Array<Record<string, unknown>>) {
  const purge = tool({
    name: 'purge',
    description: 'Delete old records',
    parameters: z.object({ olderThanDays: z.number().optional() }),
    execute: async (args) => {
      purged.push(args);
      return 'purged';
    },
  });
  return new Agent({ name: 'janitor', model: 'scripted/m', instructions: 'x', tools: [purge] });
}

const purgeCall: ToolCall = { id: 'c1', name: 'purge', arguments: { olderThanDays: 3 } };

describe('normalizeTurn', () => {
  it('makes a turn with tool calls a tool turn whatever stop the provider reported', () => {
    expect(normalizeTurn(turn({ toolCalls: [purgeCall], finishReason: 'stop' }))).toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [purgeCall],
    });
  });

  it.each(['length', 'content_filter', 'refusal', 'error'] as const)(
    'drops the tool calls of a turn that ended with %s',
    (finishReason) => {
      const normalized = normalizeTurn(turn({ toolCalls: [purgeCall], finishReason }));
      expect(normalized.finishReason).toBe(finishReason);
      expect(normalized.toolCalls).toBeUndefined();
    }
  );

  it('makes a tool_calls stop without any call a plain answer', () => {
    expect(normalizeTurn(turn({ content: 'hi', finishReason: 'tool_calls' })).finishReason).toBe(
      'stop'
    );
  });
});

describe('the outcome of a turn in a run', () => {
  it('runs tool calls an OpenAI-compatible server reports with finish_reason stop', async () => {
    const purged: Array<Record<string, unknown>> = [];
    const backend = scripted([
      turn({ toolCalls: [purgeCall], finishReason: 'stop' }),
      turn({ content: 'done' }),
    ]);
    const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

    const result = await cog.run(purgeAgent(purged), { input: 'clean up' });

    expect(purged).toEqual([{ olderThanDays: 3 }]);
    expect(result.output).toBe('done');
    expect(result.status).toBe('completed');
    await cog.close();
  });

  it.each([false, true])(
    'never runs a tool call cut off at the token limit (stream: %s)',
    async (stream) => {
      const purged: Array<Record<string, unknown>> = [];
      const backend = scripted([
        turn({ toolCalls: [{ id: 'c1', name: 'purge', arguments: {} }], finishReason: 'length' }),
      ]);
      const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

      const result = await cog.run(purgeAgent(purged), {
        input: 'clean up',
        ...(stream && { stream: true, onToken: () => undefined }),
      });

      expect(purged).toEqual([]);
      expect(result.truncated).toBe(true);
      expect(result.toolCalls).toEqual([]);
      const last = result.messages[result.messages.length - 1] as { toolCalls?: ToolCall[] };
      expect(last.toolCalls).toBeUndefined();
      await cog.close();
    }
  );

  it.each([false, true])(
    'fails the run with the provider message when a turn ends in an error (stream: %s)',
    async (stream) => {
      const purged: Array<Record<string, unknown>> = [];
      const backend = scripted([
        turn({
          toolCalls: [{ id: 'c1', name: 'purge', arguments: {} }],
          finishReason: 'error',
          finishMessage: 'Malformed function call: purge{olderThanDays: ',
        }),
        turn({ content: 'second try' }),
      ]);
      const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

      const run = cog.run(purgeAgent(purged), {
        input: 'clean up',
        ...(stream && { stream: true, onToken: () => undefined }),
      });

      await expect(run).rejects.toMatchObject({
        code: 'LLM_INVALID_RESPONSE',
        message: expect.stringContaining('Malformed function call: purge{olderThanDays: '),
      });
      expect(purged).toEqual([]);
      await cog.close();
    }
  );

  it.each([
    ['content_filter', ''],
    ['refusal', 'I cannot help with that.'],
  ] as const)(
    'reports a %s answer on the result without asking again',
    async (finishReason, content) => {
      const backend = scripted([turn({ content, finishReason }), turn({ content: 'second try' })]);
      const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

      const result = await cog.run(
        new Agent({ name: 'a', model: 'scripted/m', instructions: 'x' }),
        {
          input: 'hello',
        }
      );

      expect(result.blocked).toBe(finishReason);
      expect(result.output).toBe(content);
      expect(result.status).toBe('completed');
      expect(backend.chat).toHaveBeenCalledTimes(1);
      await cog.close();
    }
  );

  it('does not ask a blocked structured answer to be repaired', async () => {
    const backend = scripted([turn({ finishReason: 'content_filter' })]);
    const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

    const result = await cog.run(
      new Agent({
        name: 'a',
        model: 'scripted/m',
        instructions: 'x',
        responseFormat: { type: 'json_schema', schema: z.object({ name: z.string() }) },
      }),
      { input: 'hello' }
    );

    expect(result.blocked).toBe('content_filter');
    expect(backend.chat).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('leaves blocked unset on an ordinary answer', async () => {
    const backend = scripted([turn({ content: 'hi' })]);
    const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

    const result = await cog.run(new Agent({ name: 'a', model: 'scripted/m', instructions: 'x' }), {
      input: 'hello',
    });

    expect(result.blocked).toBeUndefined();
    await cog.close();
  });
});

describe('a tool call whose arguments could not be read', () => {
  const broken: ToolCall = {
    id: 'c1',
    name: 'purge',
    arguments: {},
    argumentsError: 'not valid JSON: {"olderThanDays": 3',
  };

  it.each([false, true])(
    'tells the model why instead of running the tool or failing the run (stream: %s)',
    async (stream) => {
      const purged: Array<Record<string, unknown>> = [];
      const backend = scripted([
        turn({ toolCalls: [broken], finishReason: 'tool_calls' }),
        turn({ toolCalls: [{ ...purgeCall, id: 'c2' }], finishReason: 'tool_calls' }),
        turn({ content: 'done' }),
      ]);
      const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

      const result = await cog.run(purgeAgent(purged), {
        input: 'clean up',
        ...(stream && { stream: true, onToken: () => undefined }),
      });

      expect(result.status).toBe('completed');
      expect(result.output).toBe('done');
      expect(purged).toEqual([{ olderThanDays: 3 }]);
      const told = result.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1');
      expect(JSON.parse(String(told?.content))).toEqual({
        error: 'Invalid arguments: not valid JSON: {"olderThanDays": 3',
      });
      await cog.close();
    }
  );

  it('does not ask for approval of such a call', async () => {
    const onApproval = vi.fn(() => ({ approved: true }));
    const guarded = tool({
      name: 'purge',
      description: 'Delete old records',
      parameters: z.object({ olderThanDays: z.number().optional() }),
      requiresApproval: true,
      execute: async () => 'purged',
    });
    const agent = new Agent({
      name: 'janitor',
      model: 'scripted/m',
      instructions: 'x',
      tools: [guarded],
    });
    const backend = scripted([
      turn({ toolCalls: [broken], finishReason: 'tool_calls' }),
      turn({ content: 'gave up' }),
    ]);
    const cog = new Cogitator({ llm: { backends: { scripted: backend } } });

    const result = await cog.run(agent, { input: 'clean up', onApproval });

    expect(result.status).toBe('completed');
    expect(onApproval).not.toHaveBeenCalled();
    await cog.close();
  });
});
