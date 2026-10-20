import type { FakeProviderReply } from '../fake-provider';
import {
  CONFORMANCE_FIXTURE as F,
  type ConformanceMode,
  type ConformanceScenario,
  type ProviderWire,
} from '../scenarios';
import { sse } from './encoding';

const anthropicError = (
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>
): FakeProviderReply => ({
  type: 'json',
  status,
  ...(headers && { headers }),
  body: { type: 'error', error: { type, message }, request_id: 'req_conformance' },
});

/** The error types of the Messages API (platform.claude.com/docs/en/api/errors). */
const ANTHROPIC_ERRORS: Partial<Record<ConformanceScenario, FakeProviderReply>> = {
  'rate-limit': anthropicError(
    429,
    'rate_limit_error',
    'Number of requests has exceeded your rate limit',
    {
      'retry-after': String(F.retryAfterSeconds),
    }
  ),
  quota: anthropicError(402, 'billing_error', 'Your credit balance is too low to access the API'),
  auth: anthropicError(401, 'authentication_error', 'invalid x-api-key'),
  overloaded: anthropicError(529, 'overloaded_error', 'Overloaded'),
  'server-error': anthropicError(500, 'api_error', 'Internal server error'),
  'context-overflow': anthropicError(
    400,
    'invalid_request_error',
    'prompt is too long: 210000 tokens > 200000 maximum'
  ),
};

interface AnthropicTurn {
  text?: string;
  toolInput?: string;
  stopReason: string;
}

const TURNS: Partial<Record<ConformanceScenario, AnthropicTurn>> = {
  text: { text: F.text, stopReason: 'end_turn' },
  'tool-call': { toolInput: JSON.stringify(F.toolCall.arguments), stopReason: 'tool_use' },
  'tool-call-with-stop': {
    toolInput: JSON.stringify(F.toolCall.arguments),
    stopReason: 'end_turn',
  },
  'truncated-tool-call': { toolInput: F.truncatedArguments, stopReason: 'max_tokens' },
  'content-filter': { stopReason: 'refusal' },
};

const MESSAGE = {
  id: 'msg_conformance',
  type: 'message',
  role: 'assistant',
  model: 'conformance',
  stop_sequence: null,
};

function message(turn: AnthropicTurn) {
  const content: Record<string, unknown>[] = [];
  if (turn.text) content.push({ type: 'text', text: turn.text });
  if (turn.toolInput !== undefined) {
    content.push({
      type: 'tool_use',
      id: F.toolCall.id,
      name: F.toolCall.name,
      input: safeJson(turn.toolInput),
    });
  }
  return {
    ...MESSAGE,
    content,
    stop_reason: turn.stopReason,
    usage: { input_tokens: F.usage.inputTokens, output_tokens: F.usage.outputTokens },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

const event = (type: string, data: Record<string, unknown>) => sse({ type, ...data }, type);

const messageStart = event('message_start', {
  message: {
    ...MESSAGE,
    content: [],
    stop_reason: null,
    usage: { input_tokens: F.usage.inputTokens, output_tokens: 1 },
  },
});

const textStart = (text: string) => [
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
];

function stream(turn: AnthropicTurn): string[] {
  const events = [messageStart];
  let index = 0;
  if (turn.text) {
    events.push(
      event('content_block_start', { index, content_block: { type: 'text', text: '' } }),
      ...F.textChunks.map((text) =>
        event('content_block_delta', { index, delta: { type: 'text_delta', text } })
      ),
      event('content_block_stop', { index })
    );
    index++;
  }
  if (turn.toolInput !== undefined) {
    const half = Math.ceil(turn.toolInput.length / 2);
    events.push(
      event('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: F.toolCall.id, name: F.toolCall.name, input: {} },
      }),
      event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: turn.toolInput.slice(0, half) },
      }),
      event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: turn.toolInput.slice(half) },
      }),
      event('content_block_stop', { index })
    );
  }
  events.push(
    event('message_delta', {
      delta: { stop_reason: turn.stopReason, stop_sequence: null },
      usage: { output_tokens: F.usage.outputTokens },
    }),
    event('message_stop', {})
  );
  return events;
}

/**
 * The Anthropic Messages API at `/v1/messages`. An error inside a stream that began is an
 * `error` event, as the API sends an overload after the response started.
 */
export const anthropicWire: ProviderWire = {
  name: 'Anthropic Messages',
  reply(scenario: ConformanceScenario, mode: ConformanceMode): FakeProviderReply | undefined {
    const error = ANTHROPIC_ERRORS[scenario];
    if (error) return error;
    const streamed = (chunks: string[], hang = false): FakeProviderReply => ({
      type: 'stream',
      contentType: 'text/event-stream',
      chunks,
      hang,
    });
    switch (scenario) {
      case 'stream-error':
        return streamed([
          messageStart,
          ...textStart(F.partialText),
          event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
        ]);
      case 'abort':
        return mode === 'chat'
          ? { type: 'hang' }
          : streamed([messageStart, ...textStart(F.partialText)], true);
      default: {
        const turn = TURNS[scenario];
        if (!turn) return undefined;
        return mode === 'chat' ? { type: 'json', body: message(turn) } : streamed(stream(turn));
      }
    }
  },
};
