import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { ChatHandlerOptions, ChatInput, ChatMessage } from '../types.js';
import { StreamWriter } from '../streaming/stream-writer.js';
import { generateId } from '../streaming/encoder.js';
import {
  exceedsDeclaredSize,
  hookErrorResponse,
  isPlainObject,
  jsonError,
  readJsonBody,
  runErrorCode,
} from './http.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const CHAT_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system']);

function isChatRole(role: unknown): role is ChatMessage['role'] {
  return typeof role === 'string' && CHAT_ROLES.has(role);
}

type ParseResult = { ok: true; input: ChatInput } | { ok: false; error: string };

function parseDefaultInput(body: unknown): ParseResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  if (!Array.isArray(body.messages)) {
    return { ok: false, error: 'messages must be an array' };
  }

  if (body.threadId !== undefined && body.threadId !== null && typeof body.threadId !== 'string') {
    return { ok: false, error: 'threadId must be a string' };
  }

  if (body.metadata !== undefined && body.metadata !== null && !isPlainObject(body.metadata)) {
    return { ok: false, error: 'metadata must be an object' };
  }

  const messages: ChatMessage[] = [];
  for (const msg of body.messages) {
    if (!isPlainObject(msg) || !isChatRole(msg.role) || typeof msg.content !== 'string') {
      continue;
    }
    messages.push({
      id: typeof msg.id === 'string' && msg.id ? msg.id : generateId('msg'),
      role: msg.role,
      content: msg.content,
      metadata: isPlainObject(msg.metadata) ? msg.metadata : undefined,
    });
  }

  return {
    ok: true,
    input: {
      messages,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
    },
  };
}

function getLastUserMessage(messages: readonly ChatMessage[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content;
    }
  }
  return undefined;
}

export function createChatHandler(
  cogitator: Cogitator,
  agent: Agent,
  options?: ChatHandlerOptions
) {
  return async (req: Request): Promise<Response> => {
    if (exceedsDeclaredSize(req)) {
      return jsonError('Payload too large', 413);
    }

    let input: ChatInput;
    if (options?.parseInput) {
      try {
        input = await options.parseInput(req);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'Parse error', 400);
      }
    } else {
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      const parsed = parseDefaultInput(body.body);
      if (!parsed.ok) return jsonError(parsed.error, 400);
      input = parsed.input;
    }

    const userMessage = getLastUserMessage(input.messages);
    if (userMessage === undefined) {
      return jsonError('No user message provided', 400);
    }

    let runContext: Record<string, unknown> = {};
    if (options?.beforeRun) {
      try {
        const ctx = await options.beforeRun(req, input);
        if (ctx) runContext = ctx;
      } catch (err) {
        return hookErrorResponse(err, 'Unauthorized');
      }
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    const sw = new StreamWriter(writable.getWriter());
    const messageId = generateId('msg');

    const abortController = new AbortController();
    const abortRun = () => {
      if (!abortController.signal.aborted) abortController.abort();
    };
    const parentSignals = [req.signal, runContext.signal].filter(
      (signal): signal is AbortSignal => signal instanceof AbortSignal
    );
    for (const signal of parentSignals) {
      if (signal.aborted) abortRun();
      else signal.addEventListener('abort', abortRun, { once: true });
    }

    let queue: Promise<void> = Promise.resolve();
    const emit = (write: () => Promise<void>): Promise<void> => {
      queue = queue.then(write).catch(abortRun);
      return queue;
    };

    let textId: string | null = null;
    let streamedText = false;

    const writeText = async (delta: string) => {
      if (textId === null) {
        textId = generateId('txt');
        await sw.textStart(textId);
      }
      await sw.textDelta(textId, delta);
    };

    const endText = async () => {
      if (textId === null) return;
      const id = textId;
      textId = null;
      await sw.textEnd(id);
    };

    const runStream = async () => {
      try {
        await emit(() => sw.start(messageId));

        const result = await cogitator.run(agent, {
          input: userMessage,
          threadId: input.threadId,
          context: input.metadata,
          ...runContext,
          stream: true,
          signal: abortController.signal,
          onToken: (token: string) => {
            if (!token) return;
            streamedText = true;
            void emit(() => writeText(token));
          },
          onToolCall: (tc) => {
            void emit(async () => {
              await endText();
              await sw.toolCallStart(tc.id, tc.name);
              await sw.toolCallDelta(tc.id, JSON.stringify(tc.arguments));
              await sw.toolCallEnd(tc.id);
            });
          },
          onToolResult: (tr) => {
            void emit(() => sw.toolResult(generateId('tr'), tr.callId, tr.result));
          },
        });

        await queue;

        if (!streamedText && result.output) {
          await emit(() => writeText(result.output));
        }
        await emit(endText);

        if (options?.afterRun) {
          await options.afterRun(result);
        }

        await emit(() =>
          sw.finish(
            messageId,
            {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            },
            result.threadId
          )
        );
      } catch (err) {
        await queue;
        if (!sw.isClosed) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          await emit(async () => {
            await endText();
            await sw.error(message, runErrorCode(err));
          });
        }
      } finally {
        for (const signal of parentSignals) {
          signal.removeEventListener('abort', abortRun);
        }
        await sw.close();
      }
    };

    void runStream().catch(() => {});

    return new Response(readable, { headers: SSE_HEADERS });
  };
}
