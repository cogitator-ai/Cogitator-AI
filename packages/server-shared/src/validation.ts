import type { ToolApprovalDecision } from '@cogitator-ai/types';

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

/**
 * Which keys of a request's `context` a server hands to the run.
 *
 * The run puts `context` into the system prompt, below the agent's instructions, so a
 * client that can set it speaks with the operator's voice. `false` (the default) refuses
 * every key, a list accepts only those keys, and `true` accepts any key, for clients the
 * server trusts as much as its own code.
 */
export type ContextPolicy = boolean | readonly string[];

/** How a server reads run requests */
export interface RunRequestOptions {
  /** Keys of `context` the server accepts from clients. Default: none */
  acceptContext?: ContextPolicy;
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
export function parseRunRequest(
  body: unknown,
  options: RunRequestOptions = {}
): ParseResult<RunRequestBody> {
  if (!isJsonObject(body) || body.input === undefined || body.input === null) {
    return fail('Missing required field: input');
  }
  if (typeof body.input !== 'string') return fail('Field "input" must be a string');
  if (!isNonBlankString(body.input)) return fail('Field "input" must not be blank');
  if (body.context !== undefined && !isJsonObject(body.context)) {
    return fail('Field "context" must be an object');
  }
  const refusedKey =
    body.context === undefined ? undefined : refusedContextKey(body.context, options.acceptContext);
  if (refusedKey !== undefined) {
    return fail(`Key "${refusedKey}" of field "context" is not accepted by this server`);
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

function refusedContextKey(
  context: Record<string, unknown>,
  policy: ContextPolicy = false
): string | undefined {
  if (policy === true) return undefined;
  const accepted = policy === false ? [] : policy;
  return Object.keys(context).find((key) => !accepted.includes(key));
}

/** Validates the body of a swarm run or stream: a run body plus an optional `timeout` in ms */
export function parseSwarmRunRequest(
  body: unknown,
  options: RunRequestOptions = {}
): ParseResult<SwarmRunRequestBody> {
  const parsed = parseRunRequest(body, options);
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

/** The body of `POST /agents/:name/resume` and `/agents/:name/resume/stream` */
export interface ResumeRequestBody {
  /** The thread of the paused run */
  threadId: string;
  /** Decisions by tool call id; calls left out pause the run again */
  decisions?: Record<string, ToolApprovalDecision>;
  /** The decision for every paused call that `decisions` leaves out */
  defaultDecision?: ToolApprovalDecision;
}

const DECISION_SHAPE = '{ approved: boolean, reason?: string }';

function parseDecision(value: unknown): ToolApprovalDecision | undefined {
  if (!isJsonObject(value) || typeof value.approved !== 'boolean') return undefined;
  if (value.reason !== undefined && typeof value.reason !== 'string') return undefined;
  if (value.approved) return { approved: true };
  return value.reason === undefined
    ? { approved: false }
    : { approved: false, reason: value.reason };
}

/** Validates the body of a resume: the thread of the paused run and the decisions for it */
export function parseResumeRequest(body: unknown): ParseResult<ResumeRequestBody> {
  if (!isJsonObject(body) || body.threadId === undefined || body.threadId === null) {
    return fail('Missing required field: threadId');
  }
  if (!isNonBlankString(body.threadId)) {
    return fail('Field "threadId" must be a non-empty string');
  }

  const request: ResumeRequestBody = { threadId: body.threadId };

  if (body.decisions !== undefined) {
    if (!isJsonObject(body.decisions)) return fail('Field "decisions" must be an object');
    const decisions: Record<string, ToolApprovalDecision> = {};
    for (const [toolCallId, value] of Object.entries(body.decisions)) {
      const decision = parseDecision(value);
      if (!decision) return fail(`Each entry of "decisions" must be ${DECISION_SHAPE}`);
      decisions[toolCallId] = decision;
    }
    request.decisions = decisions;
  }

  if (body.defaultDecision !== undefined) {
    const decision = parseDecision(body.defaultDecision);
    if (!decision) return fail(`Field "defaultDecision" must be ${DECISION_SHAPE}`);
    request.defaultDecision = decision;
  }

  return { ok: true, value: request };
}

/** The roles a message added to a memory thread can have */
export type ThreadMessageRole = 'user' | 'assistant' | 'system';

/**
 * The roles a server accepts on `POST /threads/:id/messages` unless told otherwise. A
 * `system` message in a thread is read by the model as the operator's instructions, so a
 * client may add one only where the server allows it explicitly.
 */
export const DEFAULT_THREAD_MESSAGE_ROLES: readonly ThreadMessageRole[] = ['user', 'assistant'];

/** The body of `POST /threads/:id/messages` */
export interface AddMessageRequestBody {
  role: ThreadMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}

/** How a server reads messages added to threads */
export interface AddMessageRequestOptions {
  /** The roles clients may add. Default: {@link DEFAULT_THREAD_MESSAGE_ROLES} */
  roles?: readonly ThreadMessageRole[];
}

/** Validates a message added to a thread, refusing the roles the server does not accept */
export function parseAddMessageRequest(
  body: unknown,
  options: AddMessageRequestOptions = {}
): ParseResult<AddMessageRequestBody> {
  const roles = options.roles ?? DEFAULT_THREAD_MESSAGE_ROLES;
  if (!isJsonObject(body) || body.role === undefined || body.content === undefined) {
    return fail('Missing required fields: role, content');
  }
  const role = roles.find((accepted) => accepted === body.role);
  if (role === undefined) {
    return fail(`Field "role" must be one of: ${roles.join(', ')}`);
  }
  if (!isNonBlankString(body.content)) return fail('Field "content" must be a non-empty string');
  if (body.metadata !== undefined && !isJsonObject(body.metadata)) {
    return fail('Field "metadata" must be an object');
  }
  return {
    ok: true,
    value: {
      role,
      content: body.content,
      ...(body.metadata !== undefined && { metadata: body.metadata }),
    },
  };
}

/** The body of `POST /workflows/:name/run` and `/workflows/:name/stream` */
export interface WorkflowRunRequestBody {
  /** The initial workflow state */
  input?: Record<string, unknown>;
  options?: {
    maxConcurrency?: number;
    maxIterations?: number;
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validates the body of a workflow run; no body at all runs the workflow from an empty state.
 *
 * `options.checkpoint: true` is refused: a server runs each workflow on a fresh executor and
 * keeps no checkpoint store, so a checkpoint would be lost with the request. Run the
 * workflow with `WorkflowExecutor` and a `CheckpointStore` to resume it later.
 */
export function parseWorkflowRunRequest(body: unknown): ParseResult<WorkflowRunRequestBody> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isJsonObject(body)) return fail('Request body must be a JSON object');
  if (body.input !== undefined && !isJsonObject(body.input)) {
    return fail('Field "input" must be an object');
  }

  const request: WorkflowRunRequestBody = {};
  if (body.input !== undefined) request.input = body.input;

  if (body.options !== undefined) {
    if (!isJsonObject(body.options)) return fail('Field "options" must be an object');
    const { maxConcurrency, maxIterations, checkpoint } = body.options;
    if (maxConcurrency !== undefined && !isPositiveInteger(maxConcurrency)) {
      return fail('Field "options.maxConcurrency" must be a positive integer');
    }
    if (maxIterations !== undefined && !isPositiveInteger(maxIterations)) {
      return fail('Field "options.maxIterations" must be a positive integer');
    }
    if (checkpoint !== undefined && checkpoint !== false) {
      return fail(
        'Field "options.checkpoint" is not supported: the server keeps no checkpoint store'
      );
    }
    request.options = {
      ...(maxConcurrency !== undefined && { maxConcurrency }),
      ...(maxIterations !== undefined && { maxIterations }),
    };
  }

  return { ok: true, value: request };
}
