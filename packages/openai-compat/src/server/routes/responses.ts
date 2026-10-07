/**
 * Responses API (`/v1/responses`) over registered Cogitator agents: the request's `model` names
 * the agent. Responses are kept in memory, so `previous_response_id` carries a conversation on.
 */

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { InvalidRequestError } from '../../client/errors';
import { toAgentResponseFormat } from '../../client/openai-adapter';
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
  clientErrorMessage,
  openEventStream,
  parseRequestBody,
  responseUsage,
  sendModelNotFound,
  sendTurnError,
  toImageInput,
} from '../agents/shared';
import { paginate, parseLimit, parseOrder, sendInvalidRequest, sendNotFound } from './shared';

const inputText = z.looseObject({ type: z.literal('input_text'), text: z.string() });
const inputImage = z.looseObject({
  type: z.literal('input_image'),
  image_url: z.string().min(1, 'input_image needs an image_url (file_id is not supported)'),
  detail: z.enum(['low', 'high', 'auto']).optional(),
});
const outputText = z.looseObject({ type: z.literal('output_text'), text: z.string() });
const refusal = z.looseObject({ type: z.literal('refusal'), refusal: z.string() });
const contentPart = z.discriminatedUnion('type', [inputText, inputImage, outputText, refusal]);

const messageItem = z.looseObject({
  type: z.literal('message').optional(),
  id: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(contentPart)]),
});
const functionCallItem = z.looseObject({
  type: z.literal('function_call'),
  id: z.string().optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});
const functionCallOutputItem = z.looseObject({
  type: z.literal('function_call_output'),
  id: z.string().optional(),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.discriminatedUnion('type', [inputText, outputText]))]),
});
const inputItem = z.union([functionCallItem, functionCallOutputItem, messageItem]);

const functionTool = z.looseObject({
  type: z.literal('function'),
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'must match ^[a-zA-Z0-9_-]{1,64}$'),
  description: z.string().nullish(),
  parameters: z.record(z.string(), z.unknown()).nullish(),
  strict: z.boolean().nullish(),
});

const textFormat = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text') }),
  z.looseObject({ type: z.literal('json_object') }),
  z.looseObject({
    type: z.literal('json_schema'),
    name: z.string().min(1),
    description: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().nullish(),
  }),
]);

const requestSchema = z.looseObject({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(inputItem)]),
  instructions: z.string().nullish(),
  previous_response_id: z.string().nullish(),
  tools: z.array(functionTool).optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.looseObject({ type: z.literal('function'), name: z.string().min(1) }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  store: z.boolean().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  stream: z.boolean().nullish(),
  text: z.looseObject({ format: textFormat.optional() }).nullish(),
  background: z.literal(false, { error: 'background responses are not supported' }).nullish(),
});

type ResponsesRequest = z.output<typeof requestSchema>;
type InputItem = z.output<typeof inputItem>;

type OutputContent =
  | { type: 'output_text'; text: string; annotations: never[] }
  | { type: 'refusal'; refusal: string };

type OutputItem =
  | {
      type: 'message';
      id: string;
      status: 'in_progress' | 'completed' | 'incomplete';
      role: 'assistant';
      content: OutputContent[];
    }
  | {
      type: 'function_call';
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: 'in_progress' | 'completed';
    };

type ResponseStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed';

interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  status: ResponseStatus;
  completed_at: number | null;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: OutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort: null; summary: null };
  store: boolean;
  temperature: number | null;
  text: { format: Record<string, unknown> };
  tool_choice: ResponsesRequest['tool_choice'] | 'auto';
  tools: NonNullable<ResponsesRequest['tools']>;
  top_p: number | null;
  truncation: 'disabled';
  usage: ReturnType<typeof responseUsage> | null;
  user: null;
  metadata: Record<string, string>;
}

/** An input item as `GET /v1/responses/{id}/input_items` lists it. */
type StoredInputItem = InputItem & { id: string };

interface StoredResponse {
  response: ResponseObject;
  /** The conversation up to and including this response, for `previous_response_id` */
  conversation: ConversationItem[];
  inputItems: StoredInputItem[];
}

/** Responses kept in memory, the oldest dropped first beyond `maxSize`. */
export class ResponseStore {
  private responses = new Map<string, StoredResponse>();

  constructor(private readonly maxSize = 1000) {}

  get(id: string): StoredResponse | undefined {
    return this.responses.get(id);
  }

  set(id: string, stored: StoredResponse): void {
    this.responses.delete(id);
    this.responses.set(id, stored);
    while (this.responses.size > this.maxSize) {
      const oldest = this.responses.keys().next().value;
      if (oldest === undefined) break;
      this.responses.delete(oldest);
    }
  }

  delete(id: string): boolean {
    return this.responses.delete(id);
  }
}

function partsText(
  parts: string | ReadonlyArray<{ type: string; text?: string; refusal?: string }>
) {
  if (typeof parts === 'string') return parts;
  return parts.map((part) => part.text ?? part.refusal ?? '').join('');
}

function toConversationItems(input: ResponsesRequest['input']): ConversationItem[] {
  if (typeof input === 'string') return [{ kind: 'user', text: input, images: [] }];
  return input.map((item): ConversationItem => {
    if (item.type === 'function_call') {
      return {
        kind: 'function_call',
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
    }
    if (item.type === 'function_call_output') {
      return { kind: 'function_call_output', callId: item.call_id, output: partsText(item.output) };
    }
    switch (item.role) {
      case 'system':
      case 'developer':
        return { kind: 'system', text: partsText(item.content) };
      case 'assistant':
        return { kind: 'assistant', text: partsText(item.content) };
      case 'user': {
        if (typeof item.content === 'string')
          return { kind: 'user', text: item.content, images: [] };
        const text = item.content
          .flatMap((part) =>
            part.type === 'input_text' || part.type === 'output_text' ? [part.text] : []
          )
          .join('\n');
        const images = item.content.flatMap((part) =>
          part.type === 'input_image' ? [toImageInput(part.image_url)] : []
        );
        return { kind: 'user', text, images };
      }
    }
  });
}

function toStoredInputItems(input: ResponsesRequest['input']): StoredInputItem[] {
  const items: InputItem[] =
    typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input;
  return items.map((item) => ({
    ...item,
    id:
      item.id ??
      `${item.type === 'function_call' ? 'fc' : item.type === 'function_call_output' ? 'fco' : 'msg'}_${nanoid()}`,
  }));
}

function toToolChoice(choice: ResponsesRequest['tool_choice']): TurnToolChoice {
  if (choice === undefined) return 'auto';
  if (typeof choice === 'string') return choice;
  return { name: choice.name };
}

function toResponseFormat(format: NonNullable<ResponsesRequest['text']>['format']) {
  if (!format) return undefined;
  if (format.type === 'json_schema') {
    return toAgentResponseFormat({
      type: 'json_schema',
      json_schema: {
        name: format.name,
        schema: format.schema,
        ...(format.description !== undefined && { description: format.description }),
      },
    });
  }
  return toAgentResponseFormat({ type: format.type });
}

/** What the turn added to the conversation, for the next response that builds on this one. */
function outputConversation(output: readonly OutputItem[]): ConversationItem[] {
  return output.flatMap((item): ConversationItem[] => {
    if (item.type === 'function_call') {
      return [
        { kind: 'function_call', callId: item.call_id, name: item.name, arguments: item.arguments },
      ];
    }
    const text = item.content
      .map((part) => (part.type === 'output_text' ? part.text : part.refusal))
      .join('');
    return text ? [{ kind: 'assistant', text }] : [];
  });
}

function finalStatus(result: AgentTurnResult): {
  status: ResponseStatus;
  incomplete: ResponseObject['incomplete_details'];
} {
  if (result.finishReason === 'length') {
    return { status: 'incomplete', incomplete: { reason: 'max_output_tokens' } };
  }
  if (result.finishReason === 'content_filter') {
    return { status: 'incomplete', incomplete: { reason: 'content_filter' } };
  }
  return { status: 'completed', incomplete: null };
}

export interface ResponseRouteOptions {
  directory: AgentDirectory;
  runner: AgentTurnRunner;
  store: ResponseStore;
  heartbeatMs: number;
  bodyLimit: number;
}

export function registerResponseRoutes(fastify: FastifyInstance, options: ResponseRouteOptions) {
  const { directory, runner, store, heartbeatMs, bodyLimit } = options;

  fastify.post('/v1/responses', { bodyLimit }, async (request, reply) => {
    let body: ResponsesRequest;
    let newItems: ConversationItem[];
    try {
      body = parseRequestBody(requestSchema, request.body);
      newItems = toConversationItems(body.input);
    } catch (error) {
      return sendTurnError(reply, error, 'response');
    }

    const agent = directory.get(body.model);
    if (!agent) return sendModelNotFound(reply, body.model);

    let history: ConversationItem[] = [];
    if (body.previous_response_id) {
      const previous = store.get(body.previous_response_id);
      if (!previous) {
        return sendInvalidRequest(
          reply,
          `Previous response with id '${body.previous_response_id}' not found.`,
          'previous_response_id'
        );
      }
      history = previous.conversation;
    }
    const conversation = [...history, ...newItems];
    const items: ConversationItem[] = [
      ...(body.instructions ? [{ kind: 'system' as const, text: body.instructions }] : []),
      ...conversation,
    ];
    if (!items.some((item) => item.kind !== 'system')) {
      return sendInvalidRequest(reply, 'input must contain a message', 'input');
    }

    const response: ResponseObject = {
      id: `resp_${nanoid()}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      completed_at: null,
      error: null,
      incomplete_details: null,
      instructions: body.instructions ?? null,
      max_output_tokens: body.max_output_tokens ?? null,
      model: body.model,
      output: [],
      parallel_tool_calls: body.parallel_tool_calls ?? true,
      previous_response_id: body.previous_response_id ?? null,
      reasoning: { effort: null, summary: null },
      store: body.store ?? true,
      temperature: body.temperature ?? null,
      text: { format: body.text?.format ?? { type: 'text' } },
      tool_choice: body.tool_choice ?? 'auto',
      tools: body.tools ?? [],
      top_p: body.top_p ?? null,
      truncation: 'disabled',
      usage: null,
      user: null,
      metadata: body.metadata ?? {},
    };

    const turn = (signal: AbortSignal, onToken?: (token: string) => void): AgentTurnRequest => ({
      agent,
      items,
      functions: (body.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description != null && { description: tool.description }),
        ...(tool.parameters != null && { parameters: tool.parameters }),
      })),
      toolChoice: toToolChoice(body.tool_choice),
      ...(body.parallel_tool_calls != null && { parallelToolCalls: body.parallel_tool_calls }),
      ...(body.temperature != null && { temperature: body.temperature }),
      ...(body.top_p != null && { topP: body.top_p }),
      ...(body.max_output_tokens != null && { maxTokens: body.max_output_tokens }),
      ...(body.text?.format && { responseFormat: toResponseFormat(body.text.format) }),
      signal,
      ...(onToken && { onToken }),
    });

    const finish = (
      result: AgentTurnResult,
      text: string,
      messageId: string,
      asRefusal: boolean
    ) => {
      const { status, incomplete } = finalStatus(result);
      const output: OutputItem[] = [];
      if (text || asRefusal) {
        output.push({
          type: 'message',
          id: messageId,
          status: status === 'incomplete' ? 'incomplete' : 'completed',
          role: 'assistant',
          content: [
            asRefusal
              ? { type: 'refusal', refusal: text }
              : { type: 'output_text', text, annotations: [] },
          ],
        });
      }
      for (const call of result.functionCalls) {
        output.push({
          type: 'function_call',
          id: `fc_${nanoid()}`,
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
        });
      }
      response.status = status;
      response.incomplete_details = incomplete;
      response.completed_at = status === 'completed' ? Math.floor(Date.now() / 1000) : null;
      response.output = output;
      response.usage = responseUsage(result.usage);
      if (response.store) {
        store.set(response.id, {
          response,
          conversation: [...conversation, ...outputConversation(output)],
          inputItems: toStoredInputItems(body.input),
        });
      }
    };

    try {
      const check = turn(new AbortController().signal);
      assertToolChoice(check.agent, check.functions, check.toolChoice);
    } catch (error) {
      return sendTurnError(reply, error, 'request');
    }

    if (!body.stream) {
      const signal = abortOnDisconnect(reply);
      try {
        const result = await runner.run(turn(signal));
        finish(result, result.text, `msg_${nanoid()}`, result.refusal);
      } catch (error) {
        return sendTurnError(reply, error, `Response ${response.id}`);
      }
      return reply.send(response);
    }

    const stream = openEventStream(reply, heartbeatMs);
    let sequence = 0;
    const emit = (type: string, data: Record<string, unknown>) =>
      stream.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`
      );

    const messageId = `msg_${nanoid()}`;
    let streamed = '';
    let messageOpen = false;
    const openMessage = () => {
      if (messageOpen) return;
      messageOpen = true;
      emit('response.output_item.added', {
        output_index: 0,
        item: {
          type: 'message',
          id: messageId,
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      });
      emit('response.content_part.added', {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };
    const delta = (text: string) => {
      openMessage();
      streamed += text;
      emit('response.output_text.delta', {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: text,
        logprobs: [],
      });
    };

    emit('response.created', { response: { ...response } });
    emit('response.in_progress', { response: { ...response } });
    try {
      const result = await runner.run(turn(stream.signal, delta));
      const asRefusal = result.refusal && !messageOpen;
      if (!asRefusal && !streamed && result.text) delta(result.text);
      finish(result, asRefusal ? result.text : streamed, messageId, asRefusal);

      response.output.forEach((item, outputIndex) => {
        if (item.type === 'message') {
          const part = item.content[0];
          if (part.type === 'refusal') {
            emit('response.output_item.added', {
              output_index: outputIndex,
              item: { ...item, status: 'in_progress', content: [] },
            });
            emit('response.content_part.added', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'refusal', refusal: '' },
            });
            emit('response.refusal.delta', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              delta: part.refusal,
            });
            emit('response.refusal.done', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              refusal: part.refusal,
            });
          } else {
            openMessage();
            emit('response.output_text.done', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              text: part.text,
              logprobs: [],
            });
          }
          emit('response.content_part.done', {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part,
          });
          emit('response.output_item.done', { output_index: outputIndex, item });
          return;
        }
        emit('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, arguments: '', status: 'in_progress' },
        });
        emit('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments,
        });
        emit('response.function_call_arguments.done', {
          item_id: item.id,
          output_index: outputIndex,
          name: item.name,
          arguments: item.arguments,
        });
        emit('response.output_item.done', { output_index: outputIndex, item });
      });

      emit(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
        response,
      });
    } catch (error) {
      if (!stream.signal.aborted) {
        response.status = 'failed';
        response.error = {
          code: error instanceof InvalidRequestError ? 'invalid_request' : 'server_error',
          message: clientErrorMessage(error, `Response ${response.id}`),
        };
        emit('response.failed', { response });
      }
    } finally {
      stream.end();
    }
    return reply;
  });

  fastify.get<{ Params: { id: string } }>('/v1/responses/:id', async (request, reply) => {
    const stored = store.get(request.params.id);
    if (!stored) return sendNotFound(reply, 'response', request.params.id);
    return reply.send(stored.response);
  });

  fastify.delete<{ Params: { id: string } }>('/v1/responses/:id', async (request, reply) => {
    if (!store.delete(request.params.id)) {
      return sendNotFound(reply, 'response', request.params.id);
    }
    return reply.send({ id: request.params.id, object: 'response', deleted: true });
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; order?: string; after?: string; before?: string };
  }>('/v1/responses/:id/input_items', async (request, reply) => {
    const stored = store.get(request.params.id);
    if (!stored) return sendNotFound(reply, 'response', request.params.id);
    const limit = parseLimit(request.query.limit);
    if (limit === null)
      return sendInvalidRequest(reply, 'limit must be between 1 and 100', 'limit');
    const order = parseOrder(request.query.order);
    if (order === null) return sendInvalidRequest(reply, "order must be 'asc' or 'desc'", 'order');
    const ordered = order === 'asc' ? stored.inputItems : [...stored.inputItems].reverse();
    return reply.send({
      object: 'list',
      ...paginate(ordered, { limit, after: request.query.after, before: request.query.before }),
    });
  });
}
