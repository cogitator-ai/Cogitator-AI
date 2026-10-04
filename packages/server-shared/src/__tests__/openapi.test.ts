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
    expect(
      Object.keys(property('AgentRunResponse', 'properties', 'usage', 'properties') ?? {})
    ).toEqual([
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'reasoningTokens',
      'cachedInputTokens',
      'cacheWriteTokens',
    ]);
  });

  it('documents that a run input must contain more than whitespace', () => {
    for (const name of ['AgentRunRequest', 'SwarmRunRequest']) {
      expect(property(name, 'properties', 'input')).toMatchObject({
        type: 'string',
        pattern: '\\S',
      });
    }
  });
});
