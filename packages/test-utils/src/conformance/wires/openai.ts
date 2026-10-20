import type { FakeProviderReply } from '../fake-provider';
import {
  CONFORMANCE_FIXTURE as F,
  type ConformanceMode,
  type ConformanceScenario,
  type ProviderWire,
} from '../scenarios';
import { sse } from './encoding';

const ARGUMENTS = JSON.stringify(F.toolCall.arguments);

/** The error bodies of the OpenAI API (developers.openai.com/api/docs/guides/error-codes). */
const OPENAI_ERRORS: Partial<Record<ConformanceScenario, FakeProviderReply>> = {
  'rate-limit': {
    type: 'json',
    status: 429,
    headers: { 'retry-after': String(F.retryAfterSeconds) },
    body: {
      error: {
        message: 'Rate limit reached for requests',
        type: 'requests',
        code: 'rate_limit_exceeded',
      },
    },
  },
  quota: {
    type: 'json',
    status: 429,
    body: {
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    },
  },
  auth: {
    type: 'json',
    status: 401,
    body: {
      error: {
        message: 'Incorrect API key provided',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
  },
  overloaded: {
    type: 'json',
    status: 503,
    body: {
      error: {
        message: 'The server is overloaded',
        type: 'service_unavailable_error',
        code: 'server_is_overloaded',
      },
    },
  },
  'server-error': {
    type: 'json',
    status: 500,
    body: { error: { message: 'The server had an error', type: 'server_error', code: null } },
  },
  'context-overflow': {
    type: 'json',
    status: 400,
    body: {
      error: {
        message: "This model's maximum context length is 128000 tokens.",
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    },
  },
};

const OVERLOADED = {
  message: 'The server is overloaded',
  type: 'service_unavailable_error',
  code: 'server_is_overloaded',
};

const CHAT_USAGE = {
  prompt_tokens: F.usage.inputTokens,
  completion_tokens: F.usage.outputTokens,
  total_tokens: F.usage.inputTokens + F.usage.outputTokens,
};

interface ChatTurn {
  content: string | null;
  toolArguments?: string;
  finishReason: string;
}

const CHAT_TURNS: Partial<Record<ConformanceScenario, ChatTurn>> = {
  text: { content: F.text, finishReason: 'stop' },
  'tool-call': { content: null, toolArguments: ARGUMENTS, finishReason: 'tool_calls' },
  'tool-call-with-stop': { content: null, toolArguments: ARGUMENTS, finishReason: 'stop' },
  'truncated-tool-call': {
    content: null,
    toolArguments: F.truncatedArguments,
    finishReason: 'length',
  },
  'content-filter': { content: null, finishReason: 'content_filter' },
};

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-conformance',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'conformance',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function chatStream(turn: ChatTurn): string[] {
  const events = [sse(chatChunk({ role: 'assistant', content: '' }))];
  if (turn.content) {
    for (const part of F.textChunks) events.push(sse(chatChunk({ content: part })));
  }
  if (turn.toolArguments !== undefined) {
    const half = Math.ceil(turn.toolArguments.length / 2);
    events.push(
      sse(
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: F.toolCall.id,
              type: 'function',
              function: { name: F.toolCall.name, arguments: '' },
            },
          ],
        })
      ),
      sse(
        chatChunk({
          tool_calls: [{ index: 0, function: { arguments: turn.toolArguments.slice(0, half) } }],
        })
      ),
      sse(
        chatChunk({
          tool_calls: [{ index: 0, function: { arguments: turn.toolArguments.slice(half) } }],
        })
      )
    );
  }
  events.push(sse(chatChunk({}, turn.finishReason)));
  events.push(
    sse({
      id: 'chatcmpl-conformance',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'conformance',
      choices: [],
      usage: CHAT_USAGE,
    })
  );
  events.push(sse('[DONE]'));
  return events;
}

function chatCompletion(turn: ChatTurn) {
  return {
    id: 'chatcmpl-conformance',
    object: 'chat.completion',
    created: 0,
    model: 'conformance',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content,
          refusal: null,
          ...(turn.toolArguments !== undefined && {
            tool_calls: [
              {
                id: F.toolCall.id,
                type: 'function',
                function: { name: F.toolCall.name, arguments: turn.toolArguments },
              },
            ],
          }),
        },
        finish_reason: turn.finishReason,
      },
    ],
    usage: CHAT_USAGE,
  };
}

/**
 * The Chat Completions API of OpenAI and of the servers compatible with it, at any path ending
 * in `/chat/completions`. Errors inside a stream come as a `data: {"error": ...}` chunk.
 */
export const openAIChatWire: ProviderWire = {
  name: 'OpenAI Chat Completions',
  reply(scenario: ConformanceScenario, mode: ConformanceMode): FakeProviderReply | undefined {
    const error = OPENAI_ERRORS[scenario];
    if (error) return error;
    const stream = (chunks: string[], hang = false): FakeProviderReply => ({
      type: 'stream',
      contentType: 'text/event-stream',
      chunks,
      hang,
    });
    switch (scenario) {
      case 'stream-error':
        return stream([
          sse(chatChunk({ role: 'assistant', content: F.partialText })),
          sse({ error: OVERLOADED }),
        ]);
      case 'abort':
        return mode === 'chat'
          ? { type: 'hang' }
          : stream([sse(chatChunk({ role: 'assistant', content: F.partialText }))], true);
      default: {
        const turn = CHAT_TURNS[scenario];
        if (!turn) return undefined;
        return mode === 'chat'
          ? { type: 'json', body: chatCompletion(turn) }
          : stream(chatStream(turn));
      }
    }
  },
};

interface ResponsesTurn {
  status: 'completed' | 'incomplete';
  incompleteReason?: 'max_output_tokens' | 'content_filter';
  text?: string;
  toolArguments?: string;
}

const RESPONSES_TURNS: Partial<Record<ConformanceScenario, ResponsesTurn>> = {
  text: { status: 'completed', text: F.text },
  'tool-call': { status: 'completed', toolArguments: ARGUMENTS },
  'tool-call-with-stop': { status: 'completed', toolArguments: ARGUMENTS },
  'truncated-tool-call': {
    status: 'incomplete',
    incompleteReason: 'max_output_tokens',
    toolArguments: F.truncatedArguments,
  },
  'content-filter': { status: 'incomplete', incompleteReason: 'content_filter' },
};

function responsesOutput(turn: ResponsesTurn): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (turn.text) {
    output.push({
      type: 'message',
      id: 'msg_conformance',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: turn.text, annotations: [] }],
    });
  }
  if (turn.toolArguments !== undefined) {
    output.push({
      type: 'function_call',
      id: 'fc_conformance',
      call_id: F.toolCall.id,
      name: F.toolCall.name,
      arguments: turn.toolArguments,
      status: turn.status === 'completed' ? 'completed' : 'incomplete',
    });
  }
  return output;
}

function response(turn: ResponsesTurn, output = responsesOutput(turn)) {
  return {
    id: 'resp_conformance',
    object: 'response',
    created_at: 0,
    model: 'conformance',
    status: turn.status,
    incomplete_details: turn.incompleteReason ? { reason: turn.incompleteReason } : null,
    error: null,
    output,
    usage: {
      input_tokens: F.usage.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: F.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: F.usage.inputTokens + F.usage.outputTokens,
    },
  };
}

function responsesStream(turn: ResponsesTurn): string[] {
  const inProgress = { ...response(turn, []), status: 'in_progress', incomplete_details: null };
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    sse({ type, sequence_number: sequence++, ...data }, type);
  const events = [event('response.created', { response: inProgress })];
  responsesOutput(turn).forEach((item, outputIndex) => {
    if (item.type === 'message') {
      events.push(
        event('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, status: 'in_progress', content: [] },
        })
      );
      for (const delta of F.textChunks) {
        events.push(
          event('response.output_text.delta', {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta,
          })
        );
      }
    } else {
      const args = String(item.arguments);
      events.push(
        event('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, arguments: '', status: 'in_progress' },
        }),
        event('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: outputIndex,
          delta: args,
        })
      );
    }
    events.push(event('response.output_item.done', { output_index: outputIndex, item }));
  });
  const terminal = turn.status === 'completed' ? 'response.completed' : 'response.incomplete';
  events.push(event(terminal, { response: response(turn) }));
  return events;
}

/**
 * The OpenAI Responses API at `/responses`. An error inside a stream is an `error` event.
 */
export const openAIResponsesWire: ProviderWire = {
  name: 'OpenAI Responses',
  reply(scenario: ConformanceScenario, mode: ConformanceMode): FakeProviderReply | undefined {
    const error = OPENAI_ERRORS[scenario];
    if (error) return error;
    const stream = (chunks: string[], hang = false): FakeProviderReply => ({
      type: 'stream',
      contentType: 'text/event-stream',
      chunks,
      hang,
    });
    const started = [
      sse(
        {
          type: 'response.created',
          sequence_number: 0,
          response: { ...response({ status: 'completed' }, []), status: 'in_progress' },
        },
        'response.created'
      ),
      sse(
        {
          type: 'response.output_text.delta',
          sequence_number: 1,
          item_id: 'msg_conformance',
          output_index: 0,
          content_index: 0,
          delta: F.partialText,
        },
        'response.output_text.delta'
      ),
    ];
    switch (scenario) {
      case 'stream-error':
        return stream([
          ...started,
          sse(
            {
              type: 'error',
              sequence_number: 2,
              code: OVERLOADED.code,
              message: OVERLOADED.message,
              param: null,
            },
            'error'
          ),
        ]);
      case 'abort':
        return mode === 'chat' ? { type: 'hang' } : stream(started, true);
      default: {
        const turn = RESPONSES_TURNS[scenario];
        if (!turn) return undefined;
        return mode === 'chat'
          ? { type: 'json', body: response(turn) }
          : stream(responsesStream(turn));
      }
    }
  },
};
