import type { FakeProviderReply } from '../fake-provider';
import {
  CONFORMANCE_FIXTURE as F,
  type ConformanceMode,
  type ConformanceScenario,
  type ProviderWire,
} from '../scenarios';
import { ndjson } from './encoding';

const ollamaError = (
  status: number,
  error: string,
  headers?: Record<string, string>
): FakeProviderReply => ({ type: 'json', status, body: { error }, ...(headers && { headers }) });

/** What Ollama and Ollama Cloud answer when a request fails: a status and `{ error }`. */
const OLLAMA_ERRORS: Partial<Record<ConformanceScenario, FakeProviderReply>> = {
  'rate-limit': ollamaError(429, 'too many requests', {
    'retry-after': String(F.retryAfterSeconds),
  }),
  quota: ollamaError(429, "you've reached your weekly usage limit, upgrade for higher limits"),
  auth: ollamaError(401, 'unauthorized'),
  overloaded: ollamaError(503, 'server busy, please try again.  maximum pending requests exceeded'),
  'server-error': ollamaError(500, 'llama runner process has terminated: exit status 2'),
  'context-overflow': ollamaError(400, 'input length exceeds the context length'),
};

interface OllamaTurn {
  text?: string;
  call?: boolean;
  doneReason: string;
}

const TURNS: Partial<Record<ConformanceScenario, OllamaTurn>> = {
  text: { text: F.text, doneReason: 'stop' },
  'tool-call': { call: true, doneReason: 'stop' },
  'tool-call-with-stop': { call: true, doneReason: 'stop' },
  'truncated-tool-call': { doneReason: 'length' },
};

const TOOL_CALL = { function: { name: F.toolCall.name, arguments: F.toolCall.arguments } };

const line = (message: Record<string, unknown>, done = false, doneReason?: string) => ({
  model: 'conformance',
  created_at: '2026-10-20T00:00:00Z',
  message: { role: 'assistant', content: '', ...message },
  done,
  ...(done && {
    done_reason: doneReason,
    prompt_eval_count: F.usage.inputTokens,
    eval_count: F.usage.outputTokens,
  }),
});

function stream(turn: OllamaTurn): string[] {
  const lines: string[] = [];
  if (turn.text) for (const content of F.textChunks) lines.push(ndjson(line({ content })));
  if (turn.call) lines.push(ndjson(line({ tool_calls: [TOOL_CALL] })));
  lines.push(ndjson(line({}, true, turn.doneReason)));
  return lines;
}

/**
 * Ollama's native `/api/chat`, streaming newline-delimited JSON. Ollama has no content filter,
 * and it hands out tool calls only once they are whole, so a cut-off call never reaches the
 * client.
 */
export const ollamaWire: ProviderWire = {
  name: 'Ollama',
  reply(scenario: ConformanceScenario, mode: ConformanceMode): FakeProviderReply | undefined {
    const error = OLLAMA_ERRORS[scenario];
    if (error) return error;
    const streamed = (chunks: string[], hang = false): FakeProviderReply => ({
      type: 'stream',
      contentType: 'application/x-ndjson',
      chunks,
      hang,
    });
    const started = ndjson(line({ content: F.partialText }));
    switch (scenario) {
      case 'stream-error':
        return streamed([
          started,
          ndjson({ error: 'server busy, please try again.  maximum pending requests exceeded' }),
        ]);
      case 'abort':
        return mode === 'chat' ? { type: 'hang' } : streamed([started], true);
      default: {
        const turn = TURNS[scenario];
        if (!turn) return undefined;
        if (mode === 'stream') return streamed(stream(turn));
        return {
          type: 'json',
          body: line(
            { content: turn.text ?? '', ...(turn.call && { tool_calls: [TOOL_CALL] }) },
            true,
            turn.doneReason
          ),
        };
      }
    }
  },
};
