/** The outcome of parsing a request body: the typed value, or why it was refused */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * The JSON Schema `pattern` of a text field that must say something: at least one
 * character that is not whitespace. Schema-driven adapters (Fastify, Tetsu) use it
 * so they refuse exactly what {@link parseRunRequest} refuses.
 */
export const NON_BLANK_PATTERN = '\\S';

/** The JSON Schema of the `input` of an agent or swarm run */
export const RUN_INPUT_SCHEMA = {
  type: 'string',
  minLength: 1,
  pattern: NON_BLANK_PATTERN,
  description: 'The message for the run; must contain more than whitespace',
} as const;

const NON_BLANK = new RegExp(NON_BLANK_PATTERN);

/** True for a string with at least one character that is not whitespace */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && NON_BLANK.test(value);
}

/** True for a plain JSON object (not `null`, not an array) */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body of `POST /agents/:name/run` and `/agents/:name/stream` */
export interface RunRequestBody {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
}

/** The longest `timeout` a run accepts: the largest delay a JavaScript timer can hold (about 24.8 days) */
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;

/** The body of `POST /swarms/:name/run` and `/swarms/:name/stream` */
export interface SwarmRunRequestBody extends RunRequestBody {
  timeout?: number;
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/**
 * Validates the body of an agent run or stream.
 *
 * `input` is required and must contain more than whitespace, so a request that
 * says nothing is refused before the model is called (and billed). Every adapter
 * answers a refusal with `400 { error: { message, code: 'INVALID_INPUT' } }`.
 */
export function parseRunRequest(body: unknown): ParseResult<RunRequestBody> {
  if (!isJsonObject(body) || body.input === undefined || body.input === null) {
    return fail('Missing required field: input');
  }
  if (typeof body.input !== 'string') return fail('Field "input" must be a string');
  if (!isNonBlankString(body.input)) return fail('Field "input" must not be blank');
  if (body.context !== undefined && !isJsonObject(body.context)) {
    return fail('Field "context" must be an object');
  }
  if (body.threadId !== undefined && !isNonBlankString(body.threadId)) {
    return fail('Field "threadId" must be a non-empty string');
  }

  return {
    ok: true,
    value: {
      input: body.input,
      ...(body.context !== undefined && { context: body.context }),
      ...(body.threadId !== undefined && { threadId: body.threadId }),
    },
  };
}

/** Validates the body of a swarm run or stream: a run body plus an optional `timeout` in ms */
export function parseSwarmRunRequest(body: unknown): ParseResult<SwarmRunRequestBody> {
  const parsed = parseRunRequest(body);
  if (!parsed.ok) return parsed;

  const timeout = isJsonObject(body) ? body.timeout : undefined;
  if (timeout === undefined) return parsed;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return fail('Field "timeout" must be a positive number');
  }
  if (timeout > MAX_RUN_TIMEOUT_MS) {
    return fail(`Field "timeout" must be at most ${MAX_RUN_TIMEOUT_MS} ms`);
  }
  return { ok: true, value: { ...parsed.value, timeout } };
}
