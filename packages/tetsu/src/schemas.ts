import { z } from 'zod';
import { ERROR_STATUS_CODES } from '@cogitator-ai/types';
import {
  DEFAULT_THREAD_MESSAGE_ROLES,
  MAX_RUN_TIMEOUT_MS,
  MAX_THREAD_PAGE_LIMIT,
  NON_BLANK_PATTERN,
  isJsonObject,
  parseAddMessageRequest,
  parseRunRequest,
  parseThreadPageQuery,
} from '@cogitator-ai/server-shared';
import type {
  ContextPolicy,
  RunLimits,
  ThreadMessageRole,
  ThreadPageQuery,
} from '@cogitator-ai/server-shared';

const JsonObject = z.record(z.string(), z.unknown());

export const NameParams = z.object({ name: z.string().min(1) });
export const ThreadParams = z.object({ id: z.string().min(1) });

const ThreadPageFields = z.object({
  limit: z
    .int()
    .min(1)
    .max(MAX_THREAD_PAGE_LIMIT)
    .optional()
    .describe('Messages on the page, the newest of what is left. Without it the whole thread'),
  cursor: z.string().optional().describe('The `nextCursor` of the page after the one to read'),
});

/**
 * The page of a thread `GET /threads/:id` reads: the whole thread without `limit`. The query is
 * read by `parseThreadPageQuery`, as every adapter reads it: an empty parameter counts as absent
 * and a repeated one by its last value. What it refuses fails validation.
 */
export const ThreadQuery = z.preprocess((query, ctx) => {
  const raw = isJsonObject(query) ? query : {};
  const page: ThreadPageQuery = {};
  for (const field of ['limit', 'cursor'] as const) {
    const parsed = parseThreadPageQuery({ [field]: raw[field] });
    if (parsed.ok) Object.assign(page, parsed.value);
    else
      ctx.addIssue({ code: 'custom', message: parsed.message, path: [field], input: raw[field] });
  }
  return page;
}, ThreadPageFields);

/** Text that must say something: refused when empty or whitespace only, like every adapter */
const RunInput = z
  .string()
  .regex(new RegExp(NON_BLANK_PATTERN), 'must not be blank')
  .describe('The message for the agent; must contain more than whitespace');

/** A thread id: refused when empty or whitespace only, like every adapter */
const ThreadId = z.string().regex(new RegExp(NON_BLANK_PATTERN), 'must not be blank');

const RunContext = JsonObject.describe(
  'Values the run adds to the system prompt as data. Refused unless the server accepts the keys (`acceptContext`)'
);

export const RunBody = z.object({
  input: RunInput,
  context: RunContext.optional(),
  threadId: ThreadId.optional().describe(
    'Conversation thread kept in memory. Without one the run opens a new thread, named in the answer and in the `start` event of a stream'
  ),
});

const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional().describe('Why the call was declined, shown to the model'),
});

export const ResumeBody = z.object({
  threadId: ThreadId.describe('Thread of the paused run'),
  decisions: z
    .record(z.string(), ApprovalDecisionSchema)
    .optional()
    .describe('Decisions by tool call id; calls left out pause the run again'),
  defaultDecision: ApprovalDecisionSchema.optional().describe(
    'Decision for every paused call that `decisions` leaves out'
  ),
});

const SwarmTimeout = z.number().positive().max(MAX_RUN_TIMEOUT_MS);
const SWARM_TIMEOUT = 'Run timeout in milliseconds, at most the longest delay a timer can hold';

export const SwarmRunBody = RunBody.extend({
  timeout: SwarmTimeout.optional().describe(SWARM_TIMEOUT),
});

const WorkflowLimit = z.number().int().positive();
const MAX_CONCURRENCY = 'Most workflow nodes that may run at once';
const MAX_ITERATIONS = 'Most iterations the workflow may take';

const WorkflowOptions = z.object({
  maxConcurrency: WorkflowLimit.optional().describe(MAX_CONCURRENCY),
  maxIterations: WorkflowLimit.optional().describe(MAX_ITERATIONS),
  checkpoint: z
    .literal(false)
    .optional()
    .describe('Only `false`: the server keeps no checkpoint store to resume from'),
});

export const WorkflowRunBody = z.object({
  input: JsonObject.optional().describe('Initial workflow state'),
  options: WorkflowOptions.optional(),
});

/**
 * A field the operator may cap. The cap is no maximum the request is refused over: the server
 * holds a larger value to it and gives it to a request that asks for nothing, so the schema
 * shows it as the default and says so.
 */
function limited(schema: z.ZodNumber, description: string, cap: number | undefined, unit = '') {
  return cap === undefined
    ? schema.optional().describe(description)
    : schema
        .default(cap)
        .describe(
          `${description}. Held to ${cap}${unit}, the server's limit, which is also the default`
        );
}

export const AddMessageBody = z.object({
  role: z
    .enum(['user', 'assistant', 'system'])
    .describe(
      '`system` is refused unless the server accepts it (`threadMessageRoles`), since the model reads it as operator instructions'
    ),
  content: z.string().regex(new RegExp(NON_BLANK_PATTERN), 'must not be blank'),
  metadata: JsonObject.optional(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: JsonObject,
});

const ContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }),
  }),
  z.object({
    type: z.literal('image_base64'),
    image_base64: z.object({ data: z.string(), media_type: z.string() }),
  }),
]);

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export const PendingApprovalSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  arguments: JsonObject,
  description: z.string(),
  sideEffects: z.array(z.string()).optional(),
});

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

const RunUsageSchema = UsageSchema.extend({
  reasoningTokens: z
    .number()
    .optional()
    .describe('Hidden reasoning tokens, already counted in outputTokens'),
  cachedInputTokens: z
    .number()
    .optional()
    .describe('Input tokens read from the provider prompt cache'),
  cacheWriteTokens: z
    .number()
    .optional()
    .describe('Input tokens written to the provider prompt cache'),
});

export const HealthResponse = z.object({
  status: z.literal('ok'),
  uptime: z.number().describe('Milliseconds since the controller was built'),
  timestamp: z.number(),
});

export const ReadyResponse = z.object({ status: z.literal('ok') });

export const AgentListResponse = z.object({
  agents: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      tools: z.array(z.string()),
    })
  ),
});

export const AgentRunResponse = z
  .object({
    output: z.string(),
    threadId: z.string(),
    usage: RunUsageSchema,
    toolCalls: z.array(ToolCallSchema),
    reasoning: z
      .string()
      .optional()
      .describe("The model's reasoning summary, when the agent asks for one"),
    status: z
      .enum(['completed', 'paused'])
      .describe('`paused` when tool calls wait for approval; resume the run to go on'),
    pendingApprovals: z
      .array(PendingApprovalSchema)
      .optional()
      .describe('The tool calls a paused run waits on'),
    structured: z
      .unknown()
      .optional()
      .describe("The answer parsed against the agent's responseFormat"),
    structuredError: z
      .string()
      .optional()
      .describe("Why the answer does not match the agent's responseFormat"),
    truncated: z
      .literal(true)
      .optional()
      .describe('The answer stopped at the output token limit and may be cut off'),
    blocked: z
      .enum(['content_filter', 'refusal'])
      .optional()
      .describe('The provider withheld the answer'),
    iterationLimitReached: z
      .literal(true)
      .optional()
      .describe("Tool calls used up the agent's maxIterations before the model answered"),
    traceId: z.string().describe('Links the answer to the server traces'),
  })
  .describe(
    'The answer of a run. It never carries the system prompt, the history, trace spans or the checkpoint of a paused run'
  );

export const ThreadResponse = z.object({
  id: z.string(),
  messages: z.array(MessageSchema).describe('The messages of the page, oldest first'),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextCursor: z
    .string()
    .optional()
    .describe("Pass as `cursor` to read the page before this one, absent at the thread's start"),
});

export const AddMessageResponse = z.object({ success: z.literal(true) });

export const ToolListResponse = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: JsonObject,
    })
  ),
});

export const WorkflowListResponse = z.object({
  workflows: z.array(
    z.object({
      name: z.string(),
      entryPoint: z.string(),
      nodes: z.array(z.string()),
    })
  ),
});

export const WorkflowRunResponse = z.object({
  workflowId: z.string(),
  workflowName: z.string(),
  state: JsonObject,
  duration: z.number(),
  nodeResults: z.record(z.string(), z.object({ output: z.unknown(), duration: z.number() })),
});

export const SwarmListResponse = z.object({
  swarms: z.array(
    z.object({
      name: z.string(),
      strategy: z.string(),
      agents: z.array(z.string()),
    })
  ),
});

export const SwarmRunResponse = z.object({
  swarmId: z.string(),
  swarmName: z.string(),
  strategy: z.string(),
  output: z.unknown(),
  agentResults: z.record(
    z.string(),
    z.object({
      output: z.string(),
      usage: UsageSchema.extend({ cost: z.number(), duration: z.number() }),
    })
  ),
  usage: z.object({
    totalTokens: z.number(),
    totalCost: z.number(),
    elapsedTime: z.number(),
  }),
});

export const BlackboardResponse = z.object({ sections: JsonObject });

const RunPayload = z.object({
  type: z.enum(['agent', 'workflow', 'swarm']),
  name: z.string().min(1),
  input: RunInput,
  context: RunContext.optional(),
  threadId: ThreadId.optional(),
});

export const SocketMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.string().optional() }),
  z.object({ type: z.literal('stop'), id: z.string().optional() }),
  z.object({
    type: z.literal('run'),
    id: z.string().optional(),
    payload: RunPayload,
  }),
  z.object({
    type: z.literal('resume'),
    id: z.string().optional(),
    payload: ResumeBody.extend({ name: z.string().min(1) }),
  }),
]);

/** What a server accepts from its clients beyond the request schema, and what it caps */
export interface ClientTrust {
  acceptContext?: ContextPolicy;
  threadMessageRoles?: readonly ThreadMessageRole[];
  limits?: RunLimits;
}

/**
 * The request schemas of one controller: the shared ones, refined with the server's trust
 * policy through the validators every adapter shares. A `context` key the server does not
 * accept, or a thread message role it does not take, fails validation like any other field,
 * with the status and `VALIDATION_FAILED` envelope the application uses for its schemas.
 * The server's `limits` show as the defaults of the fields they cap.
 */
export function requestSchemas(trust: ClientTrust) {
  const acceptContext = trust.acceptContext ?? false;
  const roles = trust.threadMessageRoles ?? DEFAULT_THREAD_MESSAGE_ROLES;
  const limits = trust.limits;

  const acceptedContext = (
    body: { input: string; context?: Record<string, unknown> },
    ctx: z.RefinementCtx
  ) => {
    if (body.context === undefined) return;
    const parsed = parseRunRequest(body, { acceptContext });
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.message, path: ['context'] });
  };

  return {
    RunBody: RunBody.superRefine(acceptedContext),
    SwarmRunBody: SwarmRunBody.extend({
      timeout: limited(SwarmTimeout, SWARM_TIMEOUT, limits?.swarmTimeout, ' ms'),
    }).superRefine(acceptedContext),
    WorkflowRunBody: WorkflowRunBody.extend({
      options: WorkflowOptions.extend({
        maxConcurrency: limited(WorkflowLimit, MAX_CONCURRENCY, limits?.workflowMaxConcurrency),
        maxIterations: limited(WorkflowLimit, MAX_ITERATIONS, limits?.workflowMaxIterations),
      }).optional(),
    }),
    AddMessageBody: AddMessageBody.superRefine((body, ctx) => {
      const parsed = parseAddMessageRequest(body, { roles });
      if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.message, path: ['role'] });
    }),
    SocketMessage: z.discriminatedUnion('type', [
      z.object({ type: z.literal('ping'), id: z.string().optional() }),
      z.object({ type: z.literal('stop'), id: z.string().optional() }),
      z.object({
        type: z.literal('run'),
        id: z.string().optional(),
        payload: RunPayload.superRefine(acceptedContext),
      }),
      z.object({
        type: z.literal('resume'),
        id: z.string().optional(),
        payload: ResumeBody.extend({ name: z.string().min(1) }),
      }),
    ]),
  };
}

export function errorEnvelope<const E extends string>(error: E, description: string) {
  return z
    .object({
      status: z.number().int(),
      message: z.string(),
      error: z.literal(error),
    })
    .describe(description);
}

function codesFor(status: number): string[] {
  return Object.entries(ERROR_STATUS_CODES)
    .filter(([, codeStatus]) => codeStatus === status)
    .map(([code]) => code);
}

/** The envelope of an answer whose `error` is one of `codes`. */
export function errorsEnvelope(codes: readonly string[], description: string) {
  const [first, ...rest] = codes;
  if (first === undefined) throw new Error('An error envelope needs at least one code');
  return z
    .object({
      status: z.number().int(),
      message: z.string(),
      error: z.enum([first, ...rest]),
    })
    .describe(description);
}

/**
 * The envelope of every `CogitatorError` that maps to `status`, plus `extra` codes
 * the adapter answers with itself.
 */
export function failureEnvelope(status: number, description: string, extra: string[] = []) {
  const codes = [...new Set([...codesFor(status), ...extra])];
  if (codes.length === 0) throw new Error(`No error codes map to status ${status}`);
  return errorsEnvelope(codes, description);
}

/** What a run of an agent, a workflow or a swarm can fail with, besides its own refusals. */
export const RUN_FAILURES = {
  400: failureEnvelope(
    400,
    'The model, a tool or a guardrail refused the request (context too long, content filtered, invalid tool arguments, prompt injection)'
  ),
  402: failureEnvelope(
    402,
    'The model provider account is out of credits or over a quota, retrying soon does not help'
  ),
  409: failureEnvelope(409, 'The agent is already running'),
  429: failureEnvelope(429, 'The model provider is rate limiting requests; see Retry-After'),
  500: failureEnvelope(500, 'A tool, a workflow step or the sandbox failed'),
  502: failureEnvelope(502, 'The model provider answered with something unusable'),
  503: failureEnvelope(503, 'The model provider, the sandbox or a circuit breaker is unavailable'),
  504: failureEnvelope(
    504,
    'The model, a tool or the sandbox timed out, or a swarm ran past its timeout (`RUN_TIMEOUT`)',
    ['RUN_TIMEOUT']
  ),
  507: failureEnvelope(507, 'The sandbox ran out of memory'),
} as const;
