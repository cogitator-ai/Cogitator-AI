import { z } from 'zod';
import { ERROR_STATUS_CODES } from '@cogitator-ai/types';

const JsonObject = z.record(z.string(), z.unknown());

export const NameParams = z.object({ name: z.string().min(1) });
export const ThreadParams = z.object({ id: z.string().min(1) });

export const RunBody = z.object({
  input: z.string().min(1).describe('The message for the agent'),
  context: JsonObject.optional().describe('Extra values passed to the run as context'),
  threadId: z.string().min(1).optional().describe('Conversation thread kept in memory'),
});

export const SwarmRunBody = RunBody.extend({
  timeout: z.number().positive().optional().describe('Run timeout in milliseconds'),
});

export const WorkflowRunBody = z.object({
  input: JsonObject.optional().describe('Initial workflow state'),
  options: z
    .object({
      maxConcurrency: z.number().int().positive().optional(),
      maxIterations: z.number().int().positive().optional(),
      checkpoint: z.boolean().optional(),
    })
    .optional(),
});

export const AddMessageBody = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
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

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
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

export const AgentRunResponse = z.object({
  output: z.string(),
  structured: z.unknown().optional(),
  threadId: z.string(),
  usage: UsageSchema,
  toolCalls: z.array(ToolCallSchema),
});

export const ThreadResponse = z.object({
  id: z.string(),
  messages: z.array(MessageSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
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

export const SocketMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.string().optional() }),
  z.object({ type: z.literal('stop'), id: z.string().optional() }),
  z.object({
    type: z.literal('run'),
    id: z.string().optional(),
    payload: z.object({
      type: z.enum(['agent', 'workflow', 'swarm']),
      name: z.string().min(1),
      input: z.string().min(1),
      context: JsonObject.optional(),
      threadId: z.string().min(1).optional(),
    }),
  }),
]);

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
  409: failureEnvelope(409, 'The agent is already running'),
  429: failureEnvelope(429, 'The model provider is rate limiting requests; see Retry-After'),
  500: failureEnvelope(500, 'A tool, a workflow step or the sandbox failed'),
  502: failureEnvelope(502, 'The model provider answered with something unusable'),
  503: failureEnvelope(503, 'The model provider, the sandbox or a circuit breaker is unavailable'),
  504: failureEnvelope(504, 'The model, a tool or the sandbox timed out'),
  507: failureEnvelope(507, 'The sandbox ran out of memory'),
} as const;
