import { describe, it, expect, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import {
  StreamEventSchema,
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
  RunUsageSchema,
  PendingApprovalSchema,
  streamEventComponents,
} from '../stream-schemas';
import {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createReasoningStartEvent,
  createReasoningDeltaEvent,
  createReasoningEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createApprovalRequiredEvent,
  createErrorEvent,
  createFinishEvent,
  createWorkflowEvent,
  createSwarmEvent,
} from '../protocol';
import type {
  StreamEvent,
  StartEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ReasoningStartEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolResultEvent,
  ApprovalRequiredEvent,
  ErrorEvent,
  FinishEvent,
  WorkflowEvent,
  SwarmEvent,
  PendingApproval,
} from '../protocol';
import type { RunUsage } from '../usage';
import { documentStreamEvents, generateOpenAPISpec } from '../openapi';

const approval: PendingApproval = {
  toolCallId: 'call-1',
  toolName: 'deleteFile',
  arguments: { path: '/tmp/x' },
  description: 'Deletes a file',
  sideEffects: ['filesystem'],
};

const everyEvent: StreamEvent[] = [
  createStartEvent('msg-1', 'thread-1'),
  createStartEvent('msg-1'),
  createTextStartEvent('text-1'),
  createTextDeltaEvent('text-1', 'Hello'),
  createTextEndEvent('text-1'),
  createReasoningStartEvent('reasoning-1'),
  createReasoningDeltaEvent('reasoning-1', 'thinking'),
  createReasoningEndEvent('reasoning-1'),
  createToolCallStartEvent('call-1', 'search'),
  createToolCallDeltaEvent('call-1', '{"q":'),
  createToolCallEndEvent('call-1'),
  createToolResultEvent('result-1', 'call-1', { hits: [1, 2] }),
  createToolResultEvent('result-2', 'call-2', undefined),
  createApprovalRequiredEvent('thread-1', [approval]),
  createErrorEvent('Run aborted', 'RUN_ABORTED'),
  createErrorEvent('Something broke'),
  createFinishEvent(
    'msg-1',
    {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 2,
      cachedInputTokens: 4,
      cacheWriteTokens: 1,
    },
    {
      threadId: 'thread-1',
      status: 'paused',
      pendingApprovals: [approval],
      structured: { answer: 42 },
      truncated: true,
      blocked: 'refusal',
      iterationLimitReached: true,
    }
  ),
  createFinishEvent('msg-1'),
  createWorkflowEvent('node_started', { nodeName: 'fetch' }),
  createWorkflowEvent('workflow_completed', undefined),
  createSwarmEvent('swarm:start', undefined),
  createSwarmEvent('agent:complete', { agent: 'writer' }),
];

describe('stream event schemas', () => {
  it('have the shapes of the stream protocol types, field for field', () => {
    expectTypeOf<z.output<typeof StreamEventSchema>>().toEqualTypeOf<StreamEvent>();
    expectTypeOf<z.output<typeof StartEventSchema>>().toEqualTypeOf<StartEvent>();
    expectTypeOf<z.output<typeof TextStartEventSchema>>().toEqualTypeOf<TextStartEvent>();
    expectTypeOf<z.output<typeof TextDeltaEventSchema>>().toEqualTypeOf<TextDeltaEvent>();
    expectTypeOf<z.output<typeof TextEndEventSchema>>().toEqualTypeOf<TextEndEvent>();
    expectTypeOf<z.output<typeof ReasoningStartEventSchema>>().toEqualTypeOf<ReasoningStartEvent>();
    expectTypeOf<z.output<typeof ReasoningDeltaEventSchema>>().toEqualTypeOf<ReasoningDeltaEvent>();
    expectTypeOf<z.output<typeof ReasoningEndEventSchema>>().toEqualTypeOf<ReasoningEndEvent>();
    expectTypeOf<z.output<typeof ToolCallStartEventSchema>>().toEqualTypeOf<ToolCallStartEvent>();
    expectTypeOf<z.output<typeof ToolCallDeltaEventSchema>>().toEqualTypeOf<ToolCallDeltaEvent>();
    expectTypeOf<z.output<typeof ToolCallEndEventSchema>>().toEqualTypeOf<ToolCallEndEvent>();
    expectTypeOf<z.output<typeof ToolResultEventSchema>>().toEqualTypeOf<ToolResultEvent>();
    expectTypeOf<
      z.output<typeof ApprovalRequiredEventSchema>
    >().toEqualTypeOf<ApprovalRequiredEvent>();
    expectTypeOf<z.output<typeof ErrorEventSchema>>().toEqualTypeOf<ErrorEvent>();
    expectTypeOf<z.output<typeof FinishEventSchema>>().toEqualTypeOf<FinishEvent>();
    expectTypeOf<z.output<typeof WorkflowEventSchema>>().toEqualTypeOf<WorkflowEvent>();
    expectTypeOf<z.output<typeof SwarmEventSchema>>().toEqualTypeOf<SwarmEvent>();
    expectTypeOf<z.output<typeof RunUsageSchema>>().toEqualTypeOf<RunUsage>();
    expectTypeOf<z.output<typeof PendingApprovalSchema>>().toEqualTypeOf<PendingApproval>();
  });

  it('parse every event the protocol creates back into itself', () => {
    for (const event of everyEvent) {
      const sent = JSON.parse(JSON.stringify(event)) as unknown;
      expect(StreamEventSchema.parse(sent)).toEqual(sent);
    }
  });

  it('parse the result of a tool that returned nothing, which the wire leaves out', () => {
    const sent = JSON.parse(JSON.stringify(createToolResultEvent('result-1', 'call-1', undefined)));
    expect(sent).not.toHaveProperty('result');
    expect(StreamEventSchema.parse(sent)).toEqual({
      type: 'tool-result',
      id: 'result-1',
      toolCallId: 'call-1',
    });
  });

  it('drop a field a newer server adds instead of failing', () => {
    expect(
      StreamEventSchema.parse({ type: 'text-delta', id: 'text-1', delta: 'Hi', lang: 'en' })
    ).toEqual({ type: 'text-delta', id: 'text-1', delta: 'Hi' });
  });

  it('refuse an event of an unknown type or with a field of the wrong type', () => {
    expect(StreamEventSchema.safeParse({ type: 'telepathy' }).success).toBe(false);
    expect(StreamEventSchema.safeParse({ type: 'text-delta', id: 'text-1' }).success).toBe(false);
    expect(
      StreamEventSchema.safeParse({ type: 'finish', messageId: 'm', status: 'done' }).success
    ).toBe(false);
  });
});

describe('streamEventComponents', () => {
  const components = streamEventComponents();
  const refsIn = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(refsIn);
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, inner]) =>
      key === '$ref' && typeof inner === 'string' ? [inner] : refsIn(inner)
    );
  };

  it('names a component for each event, with a discriminator on type over all of them', () => {
    const streamEvent = components.StreamEvent as {
      oneOf: Array<{ $ref: string }>;
      discriminator: { propertyName: string; mapping: Record<string, string> };
    };
    const types = StreamEventSchema.options.map((option) => option.shape.type.value);

    expect(streamEvent.oneOf).toHaveLength(types.length);
    expect(streamEvent.discriminator.propertyName).toBe('type');
    expect(Object.keys(streamEvent.discriminator.mapping).sort()).toEqual([...types].sort());
    expect(Object.values(streamEvent.discriminator.mapping).sort()).toEqual(
      streamEvent.oneOf.map((option) => option.$ref).sort()
    );
  });

  it('refers only to components it defines, without JSON Schema ids', () => {
    for (const ref of refsIn(components)) {
      expect(components[ref.replace('#/components/schemas/', '')], ref).toBeDefined();
    }
    expect(JSON.stringify(components)).not.toContain('$id');
    expect(JSON.stringify(components)).not.toContain('allOf');
  });

  it('keeps the component names clients already use', () => {
    expect(components.StreamStartEvent).toMatchObject({
      required: ['type', 'messageId'],
      properties: { type: { enum: ['start'] }, threadId: { type: 'string' } },
    });
    expect(components.StreamFinishEvent).toMatchObject({
      properties: {
        usage: { $ref: '#/components/schemas/RunUsage' },
        pendingApprovals: { items: { $ref: '#/components/schemas/PendingApproval' } },
        status: { enum: ['completed', 'paused'] },
      },
    });
    expect(components.RunUsage).toMatchObject({
      required: ['inputTokens', 'outputTokens', 'totalTokens'],
    });
  });

  it('do not restrict the fields of an event, so a newer server stays valid', () => {
    for (const [name, schema] of Object.entries(components)) {
      expect(schema.additionalProperties, name).not.toBe(false);
    }
  });
});

describe('the SSE routes of the OpenAPI document', () => {
  const spec = generateOpenAPISpec(
    {
      agents: { bot: {} },
      workflows: { flow: {} },
      swarms: { team: {} },
    } as unknown as Parameters<typeof generateOpenAPISpec>[0],
    {}
  );
  const sseSchema = (path: string) =>
    (
      spec.paths[path]?.post as {
        responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      }
    ).responses[200]?.content?.['text/event-stream']?.schema;

  it('describe every stream body as stream events', () => {
    for (const path of [
      '/agents/bot/stream',
      '/agents/bot/resume/stream',
      '/workflows/flow/stream',
      '/swarms/team/stream',
    ]) {
      expect(sseSchema(path), path).toEqual({ $ref: '#/components/schemas/StreamEvent' });
    }
  });

  it('describes the outcome flags of the JSON answer and of finish alike', () => {
    const schemas = (spec.components as { schemas: Record<string, { properties: object }> })
      .schemas;
    for (const flag of ['truncated', 'iterationLimitReached', 'status', 'blocked']) {
      const { description: _json, ...json } = (
        schemas.AgentRunResponse?.properties as Record<string, Record<string, unknown>>
      )[flag]!;
      const { description: _stream, ...stream } = (
        schemas.StreamFinishEvent?.properties as Record<string, Record<string, unknown>>
      )[flag]!;
      expect(stream, flag).toEqual(json);
    }
  });

  it('documents resuming a paused run as a stream', () => {
    const resume = spec.paths['/agents/bot/resume/stream']?.post as {
      requestBody: unknown;
      responses: Record<string, unknown>;
    };
    expect(resume.requestBody).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/AgentResumeRequest' } },
      },
    });
    expect(Object.keys(resume.responses)).toEqual(expect.arrayContaining(['200', '403', '404']));
  });

  it('defines every component the document refers to', () => {
    const schemas = (spec.components as { schemas: Record<string, unknown> }).schemas;
    const refs = JSON.stringify(spec).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? [];
    for (const ref of new Set(refs)) {
      expect(schemas[ref.replace('#/components/schemas/', '')], ref).toBeDefined();
    }
  });
});

describe('documentStreamEvents', () => {
  const generated = {
    openapi: '3.0.3',
    paths: {
      '/api/agents/{name}/stream': {
        post: {
          responses: { 200: { description: 'Default Response' }, 400: { description: 'Bad' } },
        },
      },
      '/api/agents/{name}/run': { post: { responses: { 200: { description: 'Run' } } } },
      '/api/agents/{name}/stream/info': { get: { responses: {} } },
    },
    components: { schemas: { RunUsage: { type: 'object', title: 'mine' } } },
  };
  const documented = documentStreamEvents(generated);

  it('describes the 200 of a stream route as stream events, keeping its other answers', () => {
    expect(documented.paths['/api/agents/{name}/stream']?.post).toEqual({
      responses: {
        200: {
          description: 'Default Response',
          content: {
            'text/event-stream': { schema: { $ref: '#/components/schemas/StreamEvent' } },
          },
        },
        400: { description: 'Bad' },
      },
    });
    expect(documented.paths['/api/agents/{name}/run']).toBe(
      generated.paths['/api/agents/{name}/run']
    );
  });

  it('adds the stream components, keeping one the document already has', () => {
    expect(documented.components.schemas).toMatchObject({
      StreamEvent: { discriminator: { propertyName: 'type' } },
      RunUsage: { title: 'mine' },
    });
    expect(generated.components.schemas).not.toHaveProperty('StreamEvent');
  });
});
