import assert from 'node:assert/strict';
import {
  CogitatorError,
  ErrorCode,
  type ChatRequest,
  type ChatStreamChunk,
  type FinishReason,
  type LLMBackend,
  type LLMErrorKind,
  type ToolCall,
} from '@cogitator-ai/types';
import {
  startFakeProvider,
  type FakeProvider,
  type FakeProviderReply,
  type FakeProviderRequest,
} from './fake-provider';

/** Whether a case calls `chat` or reads `chatStream`. */
export type ConformanceMode = 'chat' | 'stream';

/**
 * What the provider does in a case. Each {@link ProviderWire} answers it the way its provider
 * would, and every backend must turn that answer into the same result.
 *
 * - `text`: answers {@link CONFORMANCE_FIXTURE}`.text`
 * - `tool-call`: calls `get_weather` and reports a tool stop
 * - `tool-call-with-stop`: calls the tool but reports a plain stop, as OpenAI-compatible servers
 *   do for a forced tool
 * - `truncated-tool-call`: runs out of output tokens halfway through the call's JSON
 * - `content-filter`: stops the answer for its safety policy
 * - `stream-error`: streams the start of the answer, then reports that it is overloaded
 * - `abort`: never finishes, until the caller aborts
 * - `rate-limit`, `quota`, `auth`, `overloaded`, `server-error`, `context-overflow`: fails the
 *   request with that error, the way its API reports it
 */
export type ConformanceScenario =
  | 'text'
  | 'tool-call'
  | 'tool-call-with-stop'
  | 'truncated-tool-call'
  | 'content-filter'
  | 'stream-error'
  | 'abort'
  | 'rate-limit'
  | 'quota'
  | 'auth'
  | 'overloaded'
  | 'server-error'
  | 'context-overflow';

/** The data every wire answers with, so each backend can be held to the same result. */
export const CONFORMANCE_FIXTURE = {
  text: 'Hello there',
  /** The text in the chunks a stream sends it in */
  textChunks: ['Hello', ' there'],
  /** The text a stream sends before it fails, in `stream-error` */
  partialText: 'Hel',
  toolCall: { id: 'call_weather_1', name: 'get_weather', arguments: { city: 'Paris' } },
  /** The JSON of the call's arguments where the output tokens ran out, in `truncated-tool-call` */
  truncatedArguments: '{"city": "Par',
  usage: { inputTokens: 12, outputTokens: 5 },
  /** Seconds the provider asks to wait, in `rate-limit` */
  retryAfterSeconds: 7,
  /** What the provider says in its errors */
  errorMessage: 'Conformance check error',
} as const;

/**
 * A provider's wire format: how it answers each scenario over HTTP. `undefined` means the
 * provider has no such case (Ollama has no content filter), and the case is skipped.
 */
export interface ProviderWire {
  readonly name: string;
  /** The path every request of `mode` must go to, when the wire checks it */
  path?(mode: ConformanceMode): RegExp;
  reply(
    scenario: ConformanceScenario,
    mode: ConformanceMode,
    request: FakeProviderRequest
  ): FakeProviderReply | undefined;
}

/** A backend to hold to the conformance contract. */
export interface BackendConformanceTarget {
  /** Name in the case titles */
  name: string;
  wire: ProviderWire;
  /** The backend under test, sending its requests to `providerUrl` */
  createBackend(providerUrl: string): LLMBackend;
  /** The model the requests name */
  model: string;
  /** Headers `createBackend` sets the backend to send; every request must carry them */
  headers?: Record<string, string>;
  /** Scenarios to leave out, with the reason */
  skip?: Partial<Record<ConformanceScenario, string>>;
  /** The fake provider speaks HTTP/2, for clients that only speak it (Bedrock Runtime) */
  http2?: boolean;
}

export interface BackendConformanceCase {
  /** `scenario (mode)` */
  name: string;
  scenario: ConformanceScenario;
  mode: ConformanceMode;
  /** Why the case does not apply, when it does not */
  skip?: string;
  /** Runs the case against its own fake provider; throws an `AssertionError` when the backend breaks the contract */
  run(): Promise<void>;
}

const SCENARIOS: readonly ConformanceScenario[] = [
  'text',
  'tool-call',
  'tool-call-with-stop',
  'truncated-tool-call',
  'content-filter',
  'stream-error',
  'abort',
  'rate-limit',
  'quota',
  'auth',
  'overloaded',
  'server-error',
  'context-overflow',
];

const MODES: readonly ConformanceMode[] = ['chat', 'stream'];

interface ErrorExpectation {
  code: ErrorCode;
  kind: LLMErrorKind;
  retryable: boolean;
  retryAfter?: number;
}

const ERROR_EXPECTATIONS: Partial<Record<ConformanceScenario, ErrorExpectation>> = {
  'rate-limit': {
    code: ErrorCode.LLM_RATE_LIMITED,
    kind: 'rate_limit',
    retryable: true,
    retryAfter: CONFORMANCE_FIXTURE.retryAfterSeconds * 1000,
  },
  quota: { code: ErrorCode.LLM_QUOTA_EXCEEDED, kind: 'quota', retryable: false },
  auth: { code: ErrorCode.LLM_UNAVAILABLE, kind: 'authentication', retryable: false },
  overloaded: { code: ErrorCode.LLM_UNAVAILABLE, kind: 'overloaded', retryable: true },
  'server-error': { code: ErrorCode.LLM_UNAVAILABLE, kind: 'server_error', retryable: true },
  'context-overflow': {
    code: ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED,
    kind: 'context_overflow',
    retryable: false,
  },
};

/** How long an aborted call may take to give up, and its connection to close. */
const ABORT_DEADLINE_MS = 2000;

/**
 * The conformance cases of `target`: every scenario in both modes (`stream-error` in streams
 * only), each against a fresh fake provider. Framework-agnostic, so any test runner can run them:
 *
 * ```ts
 * for (const c of backendConformanceCases(target)) {
 *   (c.skip ? it.skip : it)(c.name, () => c.run());
 * }
 * ```
 */
export function backendConformanceCases(
  target: BackendConformanceTarget
): BackendConformanceCase[] {
  return SCENARIOS.flatMap((scenario) =>
    MODES.filter((mode) => scenario !== 'stream-error' || mode === 'stream').map(
      (mode): BackendConformanceCase => {
        const skip =
          target.skip?.[scenario] ??
          (applies(target.wire, scenario, mode)
            ? undefined
            : `${target.wire.name} has no such case`);
        return {
          name: `${scenario} (${mode})`,
          scenario,
          mode,
          ...(skip && { skip }),
          run: () => runCase(target, scenario, mode),
        };
      }
    )
  );
}

function applies(wire: ProviderWire, scenario: ConformanceScenario, mode: ConformanceMode) {
  const probe: FakeProviderRequest = { method: 'POST', path: '/', headers: {}, body: undefined };
  return wire.reply(scenario, mode, probe) !== undefined;
}

/** The request every case sends: a question and the one tool the model may call. */
export function conformanceRequest(model: string, signal?: AbortSignal): ChatRequest {
  return {
    model,
    messages: [
      { role: 'system', content: 'You report the weather.' },
      { role: 'user', content: 'What is the weather in Paris?' },
    ],
    tools: [
      {
        name: CONFORMANCE_FIXTURE.toolCall.name,
        description: 'Current weather in a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    maxTokens: 64,
    ...(signal && { signal }),
  };
}

async function runCase(
  target: BackendConformanceTarget,
  scenario: ConformanceScenario,
  mode: ConformanceMode
): Promise<void> {
  const provider = await startFakeProvider({ http2: target.http2 });
  provider.reply((request) => {
    const reply = target.wire.reply(scenario, mode, request);
    if (!reply) throw new Error(`${target.wire.name} has no reply for ${scenario} (${mode})`);
    return reply;
  });
  const label = `${target.name}: ${scenario} (${mode})`;
  try {
    const backend = target.createBackend(provider.url);
    if (scenario === 'abort') {
      await checkAbort(backend, target, provider, mode, label);
    } else {
      const outcome = await callBackend(backend, conformanceRequest(target.model), mode);
      checkOutcome(scenario, mode, outcome, label);
    }
    checkRequests(target, provider, scenario, mode, label);
  } finally {
    await provider.close();
  }
}

/** What a call came to: the turn put together from the response or the stream, and how it failed. */
interface Outcome {
  content: string;
  toolCalls: Partial<ToolCall>[];
  finishReason?: FinishReason;
  usage?: { inputTokens: number; outputTokens: number };
  error?: unknown;
}

async function callBackend(
  backend: LLMBackend,
  request: ChatRequest,
  mode: ConformanceMode
): Promise<Outcome> {
  if (mode === 'chat') {
    try {
      const response = await backend.chat(request);
      return {
        content: response.content,
        toolCalls: response.toolCalls ?? [],
        finishReason: response.finishReason,
        usage: response.usage,
      };
    } catch (error) {
      return { content: '', toolCalls: [], error };
    }
  }
  const outcome: Outcome = { content: '', toolCalls: [] };
  try {
    for await (const chunk of backend.chatStream(request)) addChunk(outcome, chunk);
  } catch (error) {
    outcome.error = error;
  }
  return outcome;
}

function addChunk(outcome: Outcome, chunk: ChatStreamChunk): void {
  outcome.content += chunk.delta.content ?? '';
  outcome.toolCalls.push(...(chunk.delta.toolCalls ?? []));
  if (chunk.finishReason) outcome.finishReason = chunk.finishReason;
  if (chunk.usage) outcome.usage = chunk.usage;
}

function checkOutcome(
  scenario: ConformanceScenario,
  mode: ConformanceMode,
  outcome: Outcome,
  label: string
): void {
  const expected = ERROR_EXPECTATIONS[scenario];
  if (expected) {
    checkError(outcome.error, expected, label);
    return;
  }
  if (scenario === 'stream-error') {
    assert.equal(
      outcome.content,
      CONFORMANCE_FIXTURE.partialText,
      `${label}: the text streamed before the error is passed on`
    );
    checkError(
      outcome.error,
      { code: ErrorCode.LLM_UNAVAILABLE, kind: 'overloaded', retryable: true },
      label
    );
    return;
  }

  if (outcome.error !== undefined) {
    assert.fail(`${label}: the call failed: ${describe(outcome.error)}`);
  }
  switch (scenario) {
    case 'text':
      assert.equal(outcome.content, CONFORMANCE_FIXTURE.text, `${label}: content`);
      assert.equal(outcome.finishReason, 'stop', `${label}: finishReason`);
      assert.equal(outcome.toolCalls.length, 0, `${label}: no tool calls`);
      assert.deepEqual(
        outcome.usage && {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
        },
        CONFORMANCE_FIXTURE.usage,
        `${label}: usage${mode === 'stream' ? ' of the last chunk that reports it' : ''}`
      );
      return;
    case 'tool-call':
    case 'tool-call-with-stop': {
      assert.equal(outcome.finishReason, 'tool_calls', `${label}: a tool turn`);
      assert.equal(outcome.toolCalls.length, 1, `${label}: one tool call`);
      const [call] = outcome.toolCalls;
      assert.equal(call.name, CONFORMANCE_FIXTURE.toolCall.name, `${label}: tool name`);
      assert.deepEqual(
        call.arguments,
        CONFORMANCE_FIXTURE.toolCall.arguments,
        `${label}: tool arguments`
      );
      assert.equal(call.argumentsError, undefined, `${label}: arguments read without error`);
      assert.ok(call.id, `${label}: the call has an id`);
      return;
    }
    case 'truncated-tool-call':
      assert.equal(outcome.finishReason, 'length', `${label}: cut at the token limit`);
      assert.equal(outcome.toolCalls.length, 0, `${label}: a cut-off call never runs`);
      return;
    case 'content-filter':
      assert.ok(
        outcome.finishReason === 'content_filter' || outcome.finishReason === 'refusal',
        `${label}: finishReason is content_filter or refusal, got ${String(outcome.finishReason)}`
      );
      assert.equal(outcome.toolCalls.length, 0, `${label}: a filtered turn runs no tools`);
      return;
    default:
      assert.fail(`${label}: no check for this scenario`);
  }
}

function checkError(error: unknown, expected: ErrorExpectation, label: string): void {
  assert.ok(error !== undefined, `${label}: the call fails`);
  assert.ok(
    error instanceof CogitatorError,
    `${label}: fails with a CogitatorError, got ${describe(error)}`
  );
  assert.equal(error.code, expected.code, `${label}: code (${error.message})`);
  assert.equal(error.details?.kind, expected.kind, `${label}: details.kind (${error.message})`);
  assert.equal(error.retryable, expected.retryable, `${label}: retryable (${error.message})`);
  if (expected.retryAfter !== undefined) {
    assert.equal(error.retryAfter, expected.retryAfter, `${label}: retryAfter in milliseconds`);
  }
}

/**
 * An abort while the provider is still answering: the call gives up at once with the reason the
 * caller aborted with, not a retryable provider error a retry or fallback layer would act on,
 * and the connection to the provider closes, so it stops generating (and billing) the answer.
 */
async function checkAbort(
  backend: LLMBackend,
  target: BackendConformanceTarget,
  provider: FakeProvider,
  mode: ConformanceMode,
  label: string
): Promise<void> {
  const controller = new AbortController();
  const reason = new Error('Caller aborted the conformance call');
  const request = conformanceRequest(target.model, controller.signal);

  const arrived = provider.nextRequest();
  const settled = (async (): Promise<unknown> => {
    try {
      if (mode === 'chat') {
        await backend.chat(request);
      } else {
        for await (const chunk of backend.chatStream(request)) {
          if (chunk.delta.content) controller.abort(reason);
        }
      }
      return undefined;
    } catch (error) {
      return error;
    }
  })();

  await within(arrived, `${label}: the request reaches the provider`);
  if (mode === 'chat') controller.abort(reason);
  const error = await within(settled, `${label}: the call gives up after the abort`);
  assert.ok(error !== undefined, `${label}: the aborted call fails`);
  assert.equal(error, reason, `${label}: fails with the abort reason, got ${describe(error)}`);
  await within(provider.latestClosed(), `${label}: the connection to the provider closes`);
}

function checkRequests(
  target: BackendConformanceTarget,
  provider: FakeProvider,
  scenario: ConformanceScenario,
  mode: ConformanceMode,
  label: string
) {
  assert.ok(provider.requests.length > 0, `${label}: the backend called the provider`);
  const expected = ERROR_EXPECTATIONS[scenario];
  if (expected && !expected.retryable) {
    assert.equal(
      provider.requests.length,
      1,
      `${label}: an error that is not retryable is not retried, by the backend or its SDK`
    );
  }
  const path = target.wire.path?.(mode);
  if (path) {
    for (const request of provider.requests) {
      assert.match(request.path, path, `${label}: the request goes to the ${mode} endpoint`);
    }
  }
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    for (const request of provider.requests) {
      assert.equal(
        request.headers[name.toLowerCase()],
        value,
        `${label}: request ${request.path} carries the ${name} header`
      );
    }
  }
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new assert.AssertionError({ message: `${what} within ${ABORT_DEADLINE_MS}ms` })),
      ABORT_DEADLINE_MS
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  if (error instanceof CogitatorError) return `${error.name} ${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
