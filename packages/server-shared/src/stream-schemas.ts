import { z } from 'zod';

export const RunUsageSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    reasoningTokens: z
      .number()
      .optional()
      .describe('Hidden reasoning tokens, already counted in outputTokens'),
    cachedInputTokens: z
      .number()
      .optional()
      .describe("Input tokens read from the provider's prompt cache"),
    cacheWriteTokens: z
      .number()
      .optional()
      .describe("Input tokens written to the provider's prompt cache"),
  })
  .describe(
    'Token usage of a run, the same in the JSON response and in the finish event of the stream'
  );

export const PendingApprovalSchema = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    description: z.string(),
    sideEffects: z.array(z.string()).optional(),
  })
  .describe('A tool call waiting for an approval decision');

const threadId = z
  .string()
  .describe(
    'The thread of an agent run: the one the request named, or a new one. Send it with the next message to continue the conversation'
  );

export const StartEventSchema = z
  .object({
    type: z.literal('start'),
    messageId: z.string(),
    threadId: threadId.optional(),
  })
  .describe('The first event of a stream');

export const TextStartEventSchema = z
  .object({ type: z.literal('text-start'), id: z.string() })
  .describe('A part of the answer begins');

export const TextDeltaEventSchema = z
  .object({ type: z.literal('text-delta'), id: z.string(), delta: z.string() })
  .describe('The next text of the answer part `id`');

export const TextEndEventSchema = z
  .object({ type: z.literal('text-end'), id: z.string() })
  .describe('The answer part `id` is complete');

export const ReasoningStartEventSchema = z
  .object({ type: z.literal('reasoning-start'), id: z.string() })
  .describe("A part of the model's reasoning summary begins (`reasoning.summary` on the agent)");

export const ReasoningDeltaEventSchema = z
  .object({ type: z.literal('reasoning-delta'), id: z.string(), delta: z.string() })
  .describe('The next text of the reasoning part `id`');

export const ReasoningEndEventSchema = z
  .object({ type: z.literal('reasoning-end'), id: z.string() })
  .describe('The reasoning part `id` is complete');

export const ToolCallStartEventSchema = z
  .object({ type: z.literal('tool-call-start'), id: z.string(), toolName: z.string() })
  .describe('The model calls the tool `toolName`');

export const ToolCallDeltaEventSchema = z
  .object({ type: z.literal('tool-call-delta'), id: z.string(), argsTextDelta: z.string() })
  .describe('The next text of the JSON arguments of the tool call `id`');

export const ToolCallEndEventSchema = z
  .object({ type: z.literal('tool-call-end'), id: z.string() })
  .describe('The arguments of the tool call are complete');

export const ToolResultEventSchema = z
  .object({
    type: z.literal('tool-result'),
    id: z.string(),
    toolCallId: z.string(),
    result: z.unknown().optional(),
  })
  .describe('What the tool call `toolCallId` returned');

export const ApprovalRequiredEventSchema = z
  .object({
    type: z.literal('approval-required'),
    threadId: z.string(),
    approvals: z.array(PendingApprovalSchema),
  })
  .describe('The run paused: these tool calls wait for a decision. Resume the thread to go on');

export const ErrorEventSchema = z
  .object({ type: z.literal('error'), message: z.string(), code: z.string().optional() })
  .describe('The stream failed. `code` is the error code of the JSON routes, when known');

export const FinishEventSchema = z
  .object({
    type: z.literal('finish'),
    messageId: z.string(),
    usage: RunUsageSchema.optional(),
    threadId: threadId.optional(),
    status: z
      .enum(['completed', 'paused'])
      .optional()
      .describe('`paused` when tool calls wait for approval: resume with the thread id to go on'),
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
  })
  .describe(
    'The last event of a stream, sent before `data: [DONE]`. For an agent run it carries the thread and the outcome fields of AgentRunResponse'
  );

export const WorkflowEventSchema = z
  .object({ type: z.literal('workflow'), event: z.string(), data: z.unknown().optional() })
  .describe(
    'An event of a workflow run, named by `event`, such as `node_started`, `node_completed`, `workflow_completed` or `workflow_failed`'
  );

export const SwarmEventSchema = z
  .object({ type: z.literal('swarm'), event: z.string(), data: z.unknown().optional() })
  .describe('An event of a swarm run, named by `event`');

/**
 * Any event of the stream protocol, told apart by `type`: the events every adapter sends over SSE, one JSON object
 * per `data:` line, ending with `data: [DONE]`.
 *
 * The schemas describe the same shapes as the `StreamEvent` types and parse what a server sends, so a
 * client can check events at its boundary. Objects keep the keys they know and drop the rest,
 * so a field a newer server adds does not fail an older client.
 *
 * @example
 * ```ts
 * import { StreamEventSchema } from '@cogitator-ai/server-shared';
 *
 * const event = StreamEventSchema.parse(JSON.parse(data));
 * if (event.type === 'text-delta') process.stdout.write(event.delta);
 * ```
 */
export const StreamEventSchema = z
  .discriminatedUnion('type', [
    StartEventSchema,
    TextStartEventSchema,
    TextDeltaEventSchema,
    TextEndEventSchema,
    ReasoningStartEventSchema,
    ReasoningDeltaEventSchema,
    ReasoningEndEventSchema,
    ToolCallStartEventSchema,
    ToolCallDeltaEventSchema,
    ToolCallEndEventSchema,
    ToolResultEventSchema,
    ApprovalRequiredEventSchema,
    ErrorEventSchema,
    FinishEventSchema,
    WorkflowEventSchema,
    SwarmEventSchema,
  ])
  .describe(
    'An event of the stream protocol, the JSON of one SSE `data:` line. The stream ends with `data: [DONE]`'
  );

/** A schema of the OpenAPI 3.0 document, as plain JSON */
export type OpenAPISchemaObject = Record<string, unknown>;

const EVENT_COMPONENTS = [
  [StartEventSchema, 'StreamStartEvent'],
  [TextStartEventSchema, 'StreamTextStartEvent'],
  [TextDeltaEventSchema, 'StreamTextDeltaEvent'],
  [TextEndEventSchema, 'StreamTextEndEvent'],
  [ReasoningStartEventSchema, 'StreamReasoningStartEvent'],
  [ReasoningDeltaEventSchema, 'StreamReasoningDeltaEvent'],
  [ReasoningEndEventSchema, 'StreamReasoningEndEvent'],
  [ToolCallStartEventSchema, 'StreamToolCallStartEvent'],
  [ToolCallDeltaEventSchema, 'StreamToolCallDeltaEvent'],
  [ToolCallEndEventSchema, 'StreamToolCallEndEvent'],
  [ToolResultEventSchema, 'StreamToolResultEvent'],
  [ApprovalRequiredEventSchema, 'StreamApprovalRequiredEvent'],
  [ErrorEventSchema, 'StreamErrorEvent'],
  [FinishEventSchema, 'StreamFinishEvent'],
  [WorkflowEventSchema, 'StreamWorkflowEvent'],
  [SwarmEventSchema, 'StreamSwarmEvent'],
] as const;

const componentRef = (id: string) => `#/components/schemas/${id}`;

/** `{ allOf: [{ $ref }] }`, which Zod writes for an optional reference, as the `{ $ref }` it means */
function unwrapRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapRefs);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value);
  const [only] = entries;
  if (
    entries.length === 1 &&
    only?.[0] === 'allOf' &&
    Array.isArray(only[1]) &&
    only[1].length === 1
  ) {
    return unwrapRefs(only[1][0]);
  }
  return Object.fromEntries(entries.map(([key, inner]) => [key, unwrapRefs(inner)]));
}

/**
 * The stream protocol as OpenAPI 3.0 components, built from the Zod schemas: `StreamEvent`
 * (a `oneOf` with a discriminator on `type`), a `Stream<Name>Event` per event, `RunUsage` and
 * `PendingApproval`. Refer to an event as `#/components/schemas/StreamEvent`.
 */
export function streamEventComponents(): Record<string, OpenAPISchemaObject> {
  const registry = z.registry<{ id: string }>();
  registry.add(RunUsageSchema, { id: 'RunUsage' });
  registry.add(PendingApprovalSchema, { id: 'PendingApproval' });
  for (const [schema, id] of EVENT_COMPONENTS) registry.add(schema, { id });
  registry.add(StreamEventSchema, { id: 'StreamEvent' });

  const { schemas } = z.toJSONSchema(registry, {
    target: 'openapi-3.0',
    io: 'input',
    uri: componentRef,
  });

  const components: Record<string, OpenAPISchemaObject> = {};
  for (const [id, schema] of Object.entries(schemas)) {
    const { $id: _id, $schema: _schema, ...component } = schema as OpenAPISchemaObject;
    components[id] = unwrapRefs(component) as OpenAPISchemaObject;
  }
  components.StreamEvent = {
    ...components.StreamEvent,
    discriminator: {
      propertyName: 'type',
      mapping: Object.fromEntries(
        EVENT_COMPONENTS.map(([schema, id]) => [schema.shape.type.value, componentRef(id)])
      ),
    },
  };
  return components;
}
