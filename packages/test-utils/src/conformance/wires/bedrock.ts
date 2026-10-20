import type { FakeProviderReply } from '../fake-provider';
import {
  CONFORMANCE_FIXTURE as F,
  type ConformanceMode,
  type ConformanceScenario,
  type ProviderWire,
} from '../scenarios';
import { awsEventStreamMessage } from './encoding';

const bedrockError = (
  status: number,
  exception: string,
  message: string,
  headers?: Record<string, string>
): FakeProviderReply => ({
  type: 'json',
  status,
  headers: {
    'x-amzn-errortype': `${exception}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
    ...headers,
  },
  body: { __type: exception, message },
});

/** The exceptions of the Bedrock Runtime API, with the statuses it sends them with. */
const BEDROCK_ERRORS: Partial<Record<ConformanceScenario, FakeProviderReply>> = {
  'rate-limit': bedrockError(429, 'ThrottlingException', 'Too many requests, please wait.', {
    'retry-after': String(F.retryAfterSeconds),
  }),
  quota: bedrockError(
    400,
    'ServiceQuotaExceededException',
    'Your request exceeds the service quota for your account.'
  ),
  auth: bedrockError(
    403,
    'UnrecognizedClientException',
    'The security token included in the request is invalid.'
  ),
  overloaded: bedrockError(
    503,
    'ServiceUnavailableException',
    'Service unavailable. Try again later.'
  ),
  'server-error': bedrockError(500, 'InternalServerException', 'Internal server error.'),
  'context-overflow': bedrockError(
    400,
    'ValidationException',
    'Input is too long for requested model.'
  ),
};

interface BedrockTurn {
  text?: string;
  toolInput?: string;
  stopReason: string;
}

const TURNS: Partial<Record<ConformanceScenario, BedrockTurn>> = {
  text: { text: F.text, stopReason: 'end_turn' },
  'tool-call': { toolInput: JSON.stringify(F.toolCall.arguments), stopReason: 'tool_use' },
  'tool-call-with-stop': {
    toolInput: JSON.stringify(F.toolCall.arguments),
    stopReason: 'end_turn',
  },
  'truncated-tool-call': { toolInput: F.truncatedArguments, stopReason: 'max_tokens' },
  'content-filter': { stopReason: 'content_filtered' },
};

const USAGE = {
  inputTokens: F.usage.inputTokens,
  outputTokens: F.usage.outputTokens,
  totalTokens: F.usage.inputTokens + F.usage.outputTokens,
};

const event = (type: string, payload: Record<string, unknown>) =>
  awsEventStreamMessage(
    { ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' },
    payload
  );

const exception = (type: string, message: string) =>
  awsEventStreamMessage(
    { ':exception-type': type, ':content-type': 'application/json', ':message-type': 'exception' },
    { message }
  );

function converse(turn: BedrockTurn) {
  const content: Record<string, unknown>[] = [];
  if (turn.text) content.push({ text: turn.text });
  if (turn.toolInput !== undefined) {
    content.push({
      toolUse: { toolUseId: F.toolCall.id, name: F.toolCall.name, input: parsed(turn.toolInput) },
    });
  }
  return {
    output: { message: { role: 'assistant', content } },
    stopReason: turn.stopReason,
    usage: USAGE,
    metrics: { latencyMs: 1 },
  };
}

/** The JSON of a tool input, or an empty input for JSON cut off at the token limit. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function stream(turn: BedrockTurn): Uint8Array[] {
  const events = [event('messageStart', { role: 'assistant' })];
  let index = 0;
  if (turn.text) {
    for (const text of F.textChunks) {
      events.push(event('contentBlockDelta', { contentBlockIndex: index, delta: { text } }));
    }
    events.push(event('contentBlockStop', { contentBlockIndex: index }));
    index++;
  }
  if (turn.toolInput !== undefined) {
    const half = Math.ceil(turn.toolInput.length / 2);
    events.push(
      event('contentBlockStart', {
        contentBlockIndex: index,
        start: { toolUse: { toolUseId: F.toolCall.id, name: F.toolCall.name } },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: index,
        delta: { toolUse: { input: turn.toolInput.slice(0, half) } },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: index,
        delta: { toolUse: { input: turn.toolInput.slice(half) } },
      }),
      event('contentBlockStop', { contentBlockIndex: index })
    );
  }
  events.push(
    event('messageStop', { stopReason: turn.stopReason }),
    event('metadata', { usage: USAGE, metrics: { latencyMs: 1 } })
  );
  return events;
}

/**
 * Bedrock Runtime's Converse and ConverseStream (`/model/{id}/converse`, `/converse-stream`),
 * streaming in the AWS event stream encoding. An error inside a stream that began is an
 * exception message, such as `serviceUnavailableException`.
 */
export const bedrockConverseWire: ProviderWire = {
  name: 'Bedrock Converse',
  reply(scenario: ConformanceScenario, mode: ConformanceMode): FakeProviderReply | undefined {
    const error = BEDROCK_ERRORS[scenario];
    if (error) return error;
    const streamed = (chunks: Uint8Array[], hang = false): FakeProviderReply => ({
      type: 'stream',
      contentType: 'application/vnd.amazon.eventstream',
      chunks,
      hang,
    });
    const started = [
      event('messageStart', { role: 'assistant' }),
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: F.partialText } }),
    ];
    switch (scenario) {
      case 'stream-error':
        return streamed([
          ...started,
          exception('serviceUnavailableException', 'Service unavailable. Try again later.'),
        ]);
      case 'abort':
        return mode === 'chat' ? { type: 'hang' } : streamed(started, true);
      default: {
        const turn = TURNS[scenario];
        if (!turn) return undefined;
        return mode === 'chat' ? { type: 'json', body: converse(turn) } : streamed(stream(turn));
      }
    }
  },
};
