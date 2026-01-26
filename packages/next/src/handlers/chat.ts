import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { ChatHandlerOptions, ChatInput, ChatMessage } from '../types.js';
import { StreamWriter } from '../streaming/stream-writer.js';
import { generateId } from '../streaming/encoder.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
} as const;

function parseDefaultInput(body: unknown): ChatInput {
  const data = body as { messages?: unknown[]; threadId?: string };
  const messages: ChatMessage[] = [];

  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (msg && typeof msg === 'object' && 'role' in msg && 'content' in msg) {
        messages.push({
          id: (msg as { id?: string }).id ?? generateId('msg'),
          role: (msg as { role: string }).role as 'user' | 'assistant' | 'system',
          content: String((msg as { content: unknown }).content),
        });
      }
    }
  }

  return {
    messages,
    threadId: typeof data.threadId === 'string' ? data.threadId : undefined,
  };
}

function getLastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return '';
}

export function createChatHandler(
  cogitator: Cogitator,
  agent: Agent,
  options?: ChatHandlerOptions
) {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let input: ChatInput;
    try {
      input = options?.parseInput ? await options.parseInput(req) : parseDefaultInput(body);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : 'Parse error' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let runContext: Record<string, unknown> = {};
    if (options?.beforeRun) {
      try {
        const ctx = await options.beforeRun(req, input);
        if (ctx) runContext = ctx;
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : 'Unauthorized' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const sw = new StreamWriter(writable.getWriter());
    const messageId = generateId('msg');

    const runStream = async () => {
      let currentTextId = generateId('txt');
      let textStarted = false;

      try {
        await sw.start(messageId);
        await sw.textStart(currentTextId);
        textStarted = true;

        const userMessage = getLastUserMessage(input.messages);

        const result = await cogitator.run(agent, {
          input: userMessage,
          threadId: input.threadId,
          ...runContext,
          onToken: async (token: string) => {
            await sw.textDelta(currentTextId, token);
          },
          onToolCall: async (tc) => {
            if (textStarted) {
              await sw.textEnd(currentTextId);
              textStarted = false;
            }
            await sw.toolCallStart(tc.id, tc.name);
            await sw.toolCallDelta(tc.id, JSON.stringify(tc.arguments));
            await sw.toolCallEnd(tc.id);
          },
          onToolResult: async (tr) => {
            await sw.toolResult(generateId('tr'), tr.callId, tr.result);
            currentTextId = generateId('txt');
            await sw.textStart(currentTextId);
            textStarted = true;
          },
        });

        if (textStarted) {
          await sw.textEnd(currentTextId);
        }

        await sw.finish(messageId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });

        if (options?.afterRun) {
          await options.afterRun(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await sw.error(message);
      } finally {
        await sw.close();
      }
    };

    runStream();

    return new Response(readable, { headers: SSE_HEADERS });
  };
}
