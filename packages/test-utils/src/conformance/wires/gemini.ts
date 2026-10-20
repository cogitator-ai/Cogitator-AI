import type { FakeProviderReply } from '../fake-provider';
import {
  CONFORMANCE_FIXTURE as F,
  type ConformanceMode,
  type ConformanceScenario,
  type ProviderWire,
} from '../scenarios';
import { sse } from './encoding';

const geminiError = (
  code: number,
  status: string,
  message: string,
  details?: Record<string, unknown>[]
): FakeProviderReply => ({
  type: 'json',
  status: code,
  body: { error: { code, message, status, ...(details && { details }) } },
});

const quotaFailure = (quotaId: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [
    {
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId,
      quotaDimensions: { location: 'global', model: 'gemini-conformance' },
    },
  ],
});

/** The errors of the Gemini API (ai.google.dev/gemini-api/docs/generate-content/api-errors). */
const GEMINI_ERRORS: Partial<Record<ConformanceScenario, FakeProviderReply>> = {
  'rate-limit': geminiError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
    quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
    {
      '@type': 'type.googleapis.com/google.rpc.RetryInfo',
      retryDelay: `${F.retryAfterSeconds}s`,
    },
  ]),
  quota: geminiError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [
    quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '44s' },
  ]),
  auth: geminiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'API_KEY_INVALID',
      domain: 'googleapis.com',
    },
  ]),
  overloaded: geminiError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'),
  'server-error': geminiError(500, 'INTERNAL', 'An internal error has occurred.'),
  'context-overflow': geminiError(
    400,
    'INVALID_ARGUMENT',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).'
  ),
};

interface GeminiTurn {
  text?: string;
  call?: boolean;
  finishReason: string;
}

const TURNS: Partial<Record<ConformanceScenario, GeminiTurn>> = {
  text: { text: F.text, finishReason: 'STOP' },
  'tool-call': { call: true, finishReason: 'STOP' },
  'tool-call-with-stop': { call: true, finishReason: 'STOP' },
  'truncated-tool-call': { call: true, finishReason: 'MAX_TOKENS' },
  'content-filter': { finishReason: 'SAFETY' },
};

const USAGE = {
  promptTokenCount: F.usage.inputTokens,
  candidatesTokenCount: F.usage.outputTokens,
  totalTokenCount: F.usage.inputTokens + F.usage.outputTokens,
};

const FUNCTION_CALL = {
  functionCall: { id: F.toolCall.id, name: F.toolCall.name, args: F.toolCall.arguments },
};

function candidate(parts: Record<string, unknown>[], finishReason?: string) {
  return {
    ...(parts.length > 0 && { content: { role: 'model', parts } }),
    ...(finishReason && { finishReason }),
    index: 0,
  };
}

function partsOf(turn: GeminiTurn): Record<string, unknown>[] {
  return [...(turn.text ? [{ text: turn.text }] : []), ...(turn.call ? [FUNCTION_CALL] : [])];
}

function stream(turn: GeminiTurn): string[] {
  const chunks: string[] = [];
  if (turn.text) {
    for (const text of F.textChunks) chunks.push(sse({ candidates: [candidate([{ text }])] }));
  }
  chunks.push(
    sse({
      candidates: [candidate(turn.call ? [FUNCTION_CALL] : [], turn.finishReason)],
      usageMetadata: USAGE,
    })
  );
  return chunks;
}

/**
 * The Gemini API's `generateContent` and `streamGenerateContent?alt=sse`. An error inside a
 * stream that began is a chunk holding `{ error }`, as Google's own SDK expects it.
 */
export const geminiWire: ProviderWire = {
  name: 'Gemini',
  reply(scenario: ConformanceScenario, mode: ConformanceMode): FakeProviderReply | undefined {
    const error = GEMINI_ERRORS[scenario];
    if (error) return error;
    const streamed = (chunks: string[], hang = false): FakeProviderReply => ({
      type: 'stream',
      contentType: 'text/event-stream',
      chunks,
      hang,
    });
    const started = sse({ candidates: [candidate([{ text: F.partialText }])] });
    switch (scenario) {
      case 'stream-error':
        return streamed([
          started,
          sse({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }),
        ]);
      case 'abort':
        return mode === 'chat' ? { type: 'hang' } : streamed([started], true);
      default: {
        const turn = TURNS[scenario];
        if (!turn) return undefined;
        return mode === 'chat'
          ? {
              type: 'json',
              body: {
                candidates: [candidate(partsOf(turn), turn.finishReason)],
                usageMetadata: USAGE,
              },
            }
          : streamed(stream(turn));
      }
    }
  },
};
