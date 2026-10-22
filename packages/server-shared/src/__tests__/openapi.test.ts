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
