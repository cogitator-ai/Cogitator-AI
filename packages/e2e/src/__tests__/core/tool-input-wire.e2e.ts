import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, OpenAIBackend, tool } from '@cogitator-ai/core';
import {
  AgentStreamSession,
  StreamEventSchema,
  type StreamEvent,
} from '@cogitator-ai/server-shared';
import { startFakeProvider, type FakeProvider } from '@cogitator-ai/test-utils';

const sse = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const toolChunk = (index: number, call: Record<string, unknown>) =>
  sse({
    id: 'chatcmpl-wire',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }],
  });
const finish = (reason: string) =>
  sse({
    id: 'chatcmpl-wire',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  });
const textAnswer = (text: string) => [
  sse({
    id: 'chatcmpl-wire-2',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  }),
  'data: [DONE]\n\n',
];

/** The arguments a client reads per call: the deltas between its start and its end, as JSON */
function argumentsOnTheWire(events: StreamEvent[]): Record<string, unknown> {
  const texts = new Map<string, string>();
  const read: Record<string, unknown> = {};
  for (const event of events) {
    if (event.type === 'tool-call-start') texts.set(event.id, '');
    if (event.type === 'tool-call-delta') {
      texts.set(event.id, `${texts.get(event.id) ?? ''}${event.argsTextDelta}`);
    }
    if (event.type === 'tool-call-end' && !event.dropped) {
      read[event.id] = JSON.parse(texts.get(event.id) ?? '');
    }
  }
  return read;
}

describe('Core: streamed tool input on the wire (fake OpenAI-compatible server)', () => {
  let provider: FakeProvider | undefined;

  afterEach(async () => {
    await provider?.close();
    provider = undefined;
  });

  it(
    'sends a client the whole arguments of calls whose pieces interleave',
    { timeout: 30_000 },
    async () => {
      provider = await startFakeProvider();
      let turn = 0;
      provider.reply(() => {
        turn++;
        return {
          type: 'stream',
          contentType: 'text/event-stream',
          chunks:
            turn === 1
              ? [
                  toolChunk(0, {
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'read', arguments: '{"path":' },
                  }),
                  toolChunk(1, {
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'read', arguments: '{"path":"b.txt"}' },
                  }),
                  toolChunk(0, { function: { arguments: '"a.txt"}' } }),
                  finish('tool_calls'),
                  'data: [DONE]\n\n',
                ]
              : textAnswer('Read both.'),
        };
      });

      const read = tool({
        name: 'read',
        description: 'Reads a file',
        parameters: z.object({ path: z.string() }),
        isConcurrencySafe: true,
        execute: async ({ path }) => `contents of ${path}`,
      });
      const cog = new Cogitator({
        llm: {
          backends: {
            fake: new OpenAIBackend({ apiKey: 'test', baseUrl: `${provider.url}/v1` }),
          },
        },
      });
      const agent = new Agent({
        name: 'reader',
        model: 'fake/model',
        instructions: 'Read.',
        tools: [read],
      });

      const events: StreamEvent[] = [];
      const session = new AgentStreamSession((event) => events.push(event));
      session.start();
      const result = await cog.run(agent, {
        input: 'Read a.txt and b.txt',
        threadId: session.threadId,
        stream: true,
        parallelToolCalls: true,
        ...session.callbacks,
      });
      session.complete(result);
      await cog.close();

      for (const event of events) StreamEventSchema.parse(event);
      expect(result.toolCalls.map((call) => [call.id, call.arguments])).toEqual([
        ['call_a', { path: 'a.txt' }],
        ['call_b', { path: 'b.txt' }],
      ]);
      expect(argumentsOnTheWire(events)).toEqual({
        call_a: { path: 'a.txt' },
        call_b: { path: 'b.txt' },
      });
      expect(
        events.filter((event) => event.type === 'tool-result').map((event) => event.toolCallId)
      ).toEqual(['call_a', 'call_b']);
      expect(result.output).toBe('Read both.');
    }
  );
});
