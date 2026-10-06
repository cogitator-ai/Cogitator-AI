/**
 * Chat Completions API (`POST /v1/chat/completions`) over registered Cogitator agents: the
 * request's `model` names the agent.
 */

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { InvalidRequestError } from '../../client/errors';
import { toAgentResponseFormat } from '../../client/openai-adapter';
import type { ResponseFormat } from '../../types/openai-types';
import {
  assertToolChoice,
  type AgentTurnRequest,
  type AgentTurnResult,
  type AgentTurnRunner,
  type ConversationItem,
  type TurnToolChoice,
} from '../agents/agent-turn';
import {
  type AgentDirectory,
  abortOnDisconnect,
  chatUsage,
  clientErrorMessage,
  openEventStream,
  parseRequestBody,
  sendModelNotFound,
  sendTurnError,
  toImageInput,
} from '../agents/shared';

const textPart = z.looseObject({ type: z.literal('text'), text: z.string() });
const imagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({ url: z.string().min(1) }),
});
const refusalPart = z.looseObject({ type: z.literal('refusal'), refusal: z.string() });

const textContent = z.union([z.string(), z.array(textPart)]);

const toolCallSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.looseObject({ name: z.string().min(1), arguments: z.string() }),
});

const messageSchema = z.discriminatedUnion('role', [
  z.looseObject({ role: z.literal('system'), content: textContent }),
  z.looseObject({ role: z.literal('developer'), content: textContent }),
  z.looseObject({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.discriminatedUnion('type', [textPart, imagePart]))]),
  }),
  z.looseObject({
    role: z.literal('assistant'),
    content: z
      .union([z.string(), z.array(z.discriminatedUnion('type', [textPart, refusalPart]))])
      .nullish(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
  z.looseObject({ role: z.literal('tool'), content: textContent, tool_call_id: z.string().min(1) }),
]);

const functionSchema = z.looseObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'must match ^[a-zA-Z0-9_-]{1,64}$'),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().nullish(),
});

const responseFormatSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text') }),
  z.looseObject({ type: z.literal('json_object') }),
  z.looseObject({
    type: z.literal('json_schema'),
    json_schema: z.looseObject({
      name: z.string().min(1),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().nullish(),
    }),
  }),
]);

const positiveInt = z.number().int().positive();

const requestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().nullish(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  tools: z
    .array(z.looseObject({ type: z.literal('function'), function: functionSchema }))
    .optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.looseObject({
        type: z.literal('function'),
        function: z.looseObject({ name: z.string().min(1) }),
      }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: positiveInt.nullish(),
  max_completion_tokens: positiveInt.nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  response_format: responseFormatSchema.optional(),
  n: z.literal(1, { error: 'only n: 1 is supported' }).nullish(),
});

type ChatCompletionRequest = z.output<typeof requestSchema>;
type ChatMessage = z.output<typeof messageSchema>;

function joinText(
  content: string | ReadonlyArray<{ type: string; text?: string; refusal?: string }>
) {
  if (typeof content === 'string') return content;
  return content.map((part) => part.text ?? part.refusal ?? '').join('');
}

function toConversationItems(messages: readonly ChatMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        items.push({ kind: 'system', text: joinText(message.content) });
        break;
      case 'user': {
        if (typeof message.content === 'string') {
          items.push({ kind: 'user', text: message.content, images: [] });
          break;
        }
        const text = message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n');
        const images = message.content.flatMap((part) =>
          part.type === 'image_url' ? [toImageInput(part.image_url.url)] : []
        );
        items.push({ kind: 'user', text, images });
        break;
      }
      case 'assistant': {
        const text = message.content ? joinText(message.content) : '';
        if (text) items.push({ kind: 'assistant', text });
        for (const call of message.tool_calls ?? []) {
          items.push({
            kind: 'function_call',
            callId: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }
      case 'tool':
        items.push({
          kind: 'function_call_output',
          callId: message.tool_call_id,
          output: joinText(message.content),
        });
        break;
    }
  }
  if (!items.some((item) => item.kind !== 'system')) {
    throw new InvalidRequestError('messages must contain a user message', 'messages');
  }
  return items;
}

function toToolChoice(choice: ChatCompletionRequest['tool_choice']): TurnToolChoice {
  if (choice === undefined) return 'auto';
  if (typeof choice === 'string') return choice;
  return { name: choice.function.name };
}

function toResponseFormat(format: ChatCompletionRequest['response_format']) {
  if (!format) return undefined;
  if (format.type === 'json_schema') {
    const value: ResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name: format.json_schema.name,
        schema: format.json_schema.schema ?? {},
        ...(format.json_schema.description !== undefined && {
          description: format.json_schema.description,
        }),
      },
    };
    return toAgentResponseFormat(value);
  }
  return toAgentResponseFormat({ type: format.type });
}

function toolCallsOf(result: AgentTurnResult) {
  return result.functionCalls.map((call) => ({
    id: call.callId,
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  }));
}

export interface ChatCompletionRouteOptions {
  directory: AgentDirectory;
  runner: AgentTurnRunner;
  heartbeatMs: number;
  bodyLimit: number;
}

export function registerChatCompletionRoutes(
  fastify: FastifyInstance,
  options: ChatCompletionRouteOptions
) {
  const { directory, runner, heartbeatMs, bodyLimit } = options;

  fastify.post('/v1/chat/completions', { bodyLimit }, async (request, reply) => {
    let body: ChatCompletionRequest;
    let items: ConversationItem[];
    try {
      body = parseRequestBody(requestSchema, request.body);
      items = toConversationItems(body.messages);
    } catch (error) {
      return sendTurnError(reply, error, 'chat completion');
    }

    const agent = directory.get(body.model);
    if (!agent) return sendModelNotFound(reply, body.model);

    const id = `chatcmpl-${nanoid()}`;
    const created = Math.floor(Date.now() / 1000);
    const turn = (signal: AbortSignal, onToken?: (token: string) => void): AgentTurnRequest => ({
      agent,
      items,
      functions: (body.tools ?? []).map((tool) => ({
        name: tool.function.name,
        ...(tool.function.description !== undefined && {
          description: tool.function.description,
        }),
        ...(tool.function.parameters !== undefined && { parameters: tool.function.parameters }),
      })),
      toolChoice: toToolChoice(body.tool_choice),
      ...(body.parallel_tool_calls !== undefined && {
        parallelToolCalls: body.parallel_tool_calls,
      }),
      ...(body.temperature != null && { temperature: body.temperature }),
      ...(body.top_p != null && { topP: body.top_p }),
      ...((body.max_completion_tokens ?? body.max_tokens) != null && {
        maxTokens: (body.max_completion_tokens ?? body.max_tokens)!,
      }),
      ...(body.stop != null && { stop: typeof body.stop === 'string' ? [body.stop] : body.stop }),
      ...(body.response_format && { responseFormat: toResponseFormat(body.response_format) }),
      signal,
      ...(onToken && { onToken }),
    });

    try {
      const check = turn(new AbortController().signal);
      assertToolChoice(check.agent, check.functions, check.toolChoice);
    } catch (error) {
      return sendTurnError(reply, error, 'request');
    }

    if (!body.stream) {
      const signal = abortOnDisconnect(reply);
      let result: AgentTurnResult;
      try {
        result = await runner.run(turn(signal));
      } catch (error) {
        return sendTurnError(reply, error, `Chat completion ${id}`);
      }
      const toolCalls = toolCallsOf(result);
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        system_fingerprint: null,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.refusal ? null : result.text || (toolCalls.length > 0 ? null : ''),
              refusal: result.refusal ? result.text : null,
              ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
              annotations: [],
            },
            logprobs: null,
            finish_reason: result.finishReason,
          },
        ],
        usage: chatUsage(result.usage),
      });
    }

    const includeUsage = body.stream_options?.include_usage === true;
    const stream = openEventStream(reply, heartbeatMs);
    const chunk = (
      delta: Record<string, unknown>,
      finishReason: AgentTurnResult['finishReason'] | null = null
    ) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      system_fingerprint: null,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      ...(includeUsage && { usage: null }),
    });
    const send = (data: unknown) => stream.write(`data: ${JSON.stringify(data)}\n\n`);

    send(chunk({ role: 'assistant', content: '', refusal: null }));
    try {
      const result = await runner.run(
        turn(stream.signal, (token) => send(chunk({ content: token })))
      );
      if (result.refusal) send(chunk({ refusal: result.text }));
      const toolCalls = toolCallsOf(result);
      if (toolCalls.length > 0) {
        send(chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }));
      }
      send(chunk({}, result.finishReason));
      if (includeUsage) {
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          system_fingerprint: null,
          choices: [],
          usage: chatUsage(result.usage),
        });
      }
      stream.write('data: [DONE]\n\n');
    } catch (error) {
      if (!stream.signal.aborted) {
        const invalid = error instanceof InvalidRequestError;
        send({
          error: {
            message: clientErrorMessage(error, `Chat completion ${id}`),
            type: invalid ? 'invalid_request_error' : 'server_error',
            param: invalid ? (error.param ?? null) : null,
            code: invalid ? 'invalid_request' : 'server_error',
          },
        });
      }
    } finally {
      stream.end();
    }
    return reply;
  });
}
