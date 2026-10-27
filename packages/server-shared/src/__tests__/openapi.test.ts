import { describe, it, expect } from 'vitest';
import { generateOpenAPISpec, generateSwaggerHTML } from '../openapi';

describe('generateSwaggerHTML', () => {
  it('keeps text from the spec from breaking out of the page', () => {
    const spec = generateOpenAPISpec(
      {
        agents: { '</script><script>alert(1)</script>': { config: { instructions: 'x' } } },
        workflows: {},
        swarms: {},
      },
      { title: '<b>Shop</b> & "Co"' }
    );

    const html = generateSwaggerHTML(spec);

    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain(
      '<title>&lt;b&gt;Shop&lt;/b&gt; &amp; &quot;Co&quot; - API Documentation</title>'
    );
    const embedded = /spec: (.*),\n\s+dom_id/.exec(html)?.[1] ?? '';
    const parsed = JSON.parse(embedded) as { info: { title: string }; paths: object };
    expect(parsed.info.title).toBe('<b>Shop</b> & "Co"');
    expect(Object.keys(parsed.paths).join()).toContain('</script><script>alert(1)</script>');
  });
});

describe('generateOpenAPISpec', () => {
  const spec = generateOpenAPISpec({ agents: {}, workflows: {}, swarms: {} }, {});
  const property = (schema: string, ...path: string[]): unknown =>
    path.reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined,
      spec.components?.schemas?.[schema]
    );

  it('documents the provider token counts of a run', () => {
    expect(Object.keys(property('RunUsage', 'properties') ?? {})).toEqual([
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'reasoningTokens',
      'cachedInputTokens',
      'cacheWriteTokens',
    ]);
  });

  it('documents the same usage for the JSON run response and the finish event of the stream', () => {
    const usage = { $ref: '#/components/schemas/RunUsage' };
    expect(property('AgentRunResponse', 'properties', 'usage')).toEqual(usage);
    expect(property('StreamFinishEvent', 'properties', 'usage')).toEqual(usage);
  });

  it('documents that a run input must contain more than whitespace', () => {
    for (const name of ['AgentRunRequest', 'SwarmRunRequest']) {
      expect(property(name, 'properties', 'input')).toMatchObject({
        type: 'string',
        pattern: '\\S',
      });
    }
  });

  it('documents the readiness check path and response schema', () => {
    const readyPath = spec.paths['/ready']?.get as Record<string, unknown>;
    expect(readyPath).toBeDefined();
    expect(readyPath.summary).toBe('Readiness check');
    expect(readyPath.responses).toMatchObject({
      200: {
        description: 'Service is ready',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ReadinessResponse' } },
        },
      },
      503: {
        description: 'Service is not ready',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ReadinessResponse' } },
        },
      },
    });

    const schema = spec.components?.schemas?.ReadinessResponse as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema.required).toEqual(['status', 'checks']);
    expect(property('ReadinessResponse', 'properties', 'status')).toEqual({
      type: 'string',
      enum: ['ok', 'error'],
    });
    expect(property('ReadinessResponse', 'properties', 'checks')).toEqual({
      type: 'object',
      additionalProperties: { type: 'string', enum: ['ok', 'error', 'unchecked'] },
    });
  });

  it('documents how a run, a stream and a resume meet the other runs of their thread', () => {
    const withBot = generateOpenAPISpec(
      { agents: { bot: { config: { instructions: 'x' } } }, workflows: {}, swarms: {} },
      {}
    );
    type Responses = Record<string, { description: string; content?: object } | undefined>;
    const responses = (path: string) =>
      (withBot.paths[path]?.post as { responses: Responses }).responses;
    const errorContent = {
      'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
    };

    expect(responses('/agents/bot/run')['409']).toEqual({
      description: expect.stringMatching(/THREAD_BUSY.*RUN_INTERRUPTED/),
      content: errorContent,
    });
    expect(responses('/agents/bot/resume')['409']?.description).toMatch(
      /RUN_NOT_PAUSED.*THREAD_BUSY.*RUN_INTERRUPTED/
    );
    expect(responses('/agents/bot/resume')['410']).toEqual({
      description: expect.stringContaining('INTERRUPT_EXPIRED'),
      content: errorContent,
    });
    expect(responses('/agents/bot/stream')['409']).toBeUndefined();
    expect(responses('/agents/bot/stream')['200']?.description).toMatch(
      /THREAD_BUSY and RUN_INTERRUPTED end it with an error event/
    );
    expect(responses('/agents/bot/resume/stream')['410']).toBeUndefined();
    expect(responses('/agents/bot/resume/stream')['200']?.description).toContain(
      'INTERRUPT_EXPIRED'
    );
    expect(property('AgentRunRequest', 'properties', 'multitaskStrategy', 'description')).toMatch(
      /409, a stream sends them as an `error` event/
    );
    expect(property('SwarmRunRequest', 'properties', 'multitaskStrategy')).toBeUndefined();
  });

  it('documents the resume of a workflow from a checkpoint', () => {
    const withFlow = generateOpenAPISpec(
      { agents: {}, workflows: { flow: { entryPoint: 'a', nodes: new Map() } }, swarms: {} },
      {}
    );
    const resume = withFlow.paths['/workflows/flow/resume']?.post as {
      requestBody: unknown;
      responses: Record<string, { description: string; content?: object }>;
    };
    const stream = withFlow.paths['/workflows/flow/resume/stream']?.post as {
      responses: Record<string, { description: string; content?: object }>;
    };
    const request = {
      'application/json': { schema: { $ref: '#/components/schemas/WorkflowResumeRequest' } },
    };

    expect(resume.requestBody).toEqual({ required: true, content: request });
    expect(resume.responses['404']?.description).toContain('CHECKPOINT_NOT_FOUND');
    expect(stream.responses['404']?.description).toContain('CHECKPOINT_NOT_FOUND');
    expect(stream.responses['200']?.content).toEqual({
      'text/event-stream': { schema: { $ref: '#/components/schemas/StreamEvent' } },
    });
    expect(property('WorkflowResumeRequest', 'required')).toEqual(['checkpointId']);
    expect(property('WorkflowRunResponse', 'properties', 'checkpointId')).toMatchObject({
      type: 'string',
    });
    expect(
      property('WorkflowRunRequest', 'properties', 'options', 'properties', 'checkpoint')
    ).toMatchObject({ type: 'boolean' });
  });
});

describe('generateOpenAPISpec with resumable streams', () => {
  const context = { agents: { bot: { config: { instructions: 'x' } } }, workflows: {}, swarms: {} };
  const post = (resumableStreams: boolean, path: string) =>
    generateOpenAPISpec(context, { resumableStreams }).paths[path]?.post as {
      parameters?: Array<{ name: string; in: string }>;
      requestBody: { required: boolean };
      responses: Record<string, { description: string }>;
    };

  it.each(['/agents/bot/stream', '/agents/bot/resume/stream'])(
    'documents the reconnect of %s',
    (path) => {
      const operation = post(true, path);
      expect(operation.parameters?.map(({ name, in: where }) => [name, where])).toEqual([
        ['Last-Event-ID', 'header'],
        ['lastEventId', 'query'],
      ]);
      expect(operation.requestBody.required).toBe(false);
      expect(operation.responses[404]?.description).toContain('STREAM_NOT_FOUND');
      expect(operation.responses[200]?.description).toContain('STREAM_RESUME_GAP');
    }
  );

  it('documents the cancel route of a stream', () => {
    const spec = generateOpenAPISpec(context, { resumableStreams: true });
    const cancel = spec.paths['/agents/bot/stream/{streamId}']?.delete as {
      responses: Record<string, { description: string }>;
    };
    expect(Object.keys(cancel.responses)).toEqual(['204', '400', '403', '404']);
    expect(post(true, '/agents/bot/stream').responses[503]?.description).toContain(
      'STREAM_LIMIT_REACHED'
    );
    expect(generateOpenAPISpec(context, {}).paths['/agents/bot/stream/{streamId}']).toBeUndefined();
  });

  it('documents none of it where streams are not resumable', () => {
    const operation = post(false, '/agents/bot/stream');
    expect(operation.parameters).toBeUndefined();
    expect(operation.requestBody.required).toBe(true);
    expect(JSON.stringify(operation)).not.toContain('STREAM_NOT_FOUND');
  });
});
