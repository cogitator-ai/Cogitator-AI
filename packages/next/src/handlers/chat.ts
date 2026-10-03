import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { ChatHandlerOptions, ChatInput, ChatMessage } from '../types.js';
import { generateId } from '../streaming/encoder.js';
import {
  exceedsDeclaredSize,
  hookErrorResponse,
  isPlainObject,
  jsonError,
  readJsonBody,
} from './http.js';
import { streamAgentRun } from './stream-run.js';

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

    return streamAgentRun({
      req,
      runContext,
      start: (callbacks) =>
        cogitator.run(agent, {
          input: userMessage,
          threadId: input.threadId,
          context: input.metadata,
          ...runContext,
          ...callbacks,
        }),
      afterRun: options?.afterRun,
    });
  };
}
