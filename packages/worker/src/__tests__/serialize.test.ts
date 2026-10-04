import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveRedisOptions } from '../connection';
import { processAgentJob } from '../processors/agent';
import { serializeAgent } from '../serialize';

const Verdict = z.object({ verdict: z.enum(['run', 'hold']), reason: z.string() });

describe('serializeAgent', () => {
  it('carries the response format as JSON Schema, the effort and the tool schemas', () => {
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up',
      parameters: z.object({ q: z.string() }),
      execute: () => Promise.resolve('found'),
    });
    const agent = new Agent({
      name: 'chief',
      model: 'mock/editor',
      instructions: 'Decide.',
      temperature: 0.2,
      reasoning: { effort: 'high' },
      responseFormat: { type: 'json_schema', schema: Verdict },
      tools: [lookup],
    });

    const serialized = serializeAgent(agent);

    expect(serialized).toMatchObject({
      name: 'chief',
      model: 'mock/editor',
      temperature: 0.2,
      reasoning: { effort: 'high' },
      responseFormat: {
        type: 'json_schema',
        schema: { type: 'object', required: ['verdict', 'reason'] },
      },
      tools: [{ name: 'lookup' }],
    });
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it('refuses an agent without a model', () => {
    expect(() => serializeAgent(new Agent({ name: 'x', instructions: 'y' }))).toThrow(
      /has no model/
    );
  });
});

describe('processAgentJob', () => {
  const agent = new Agent({
    name: 'chief',
    model: 'mock/editor',
    instructions: 'Decide.',
    responseFormat: { type: 'json_schema', schema: Verdict },
    maxIterations: 2,
  });

  it('returns the validated structured answer and what the run cost', async () => {
    const mock = new MockLLMBackend().setResponse({
      content: JSON.stringify({ verdict: 'run', reason: 'Fresh and important.' }),
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.0042 },
    });
    const cogitator = new Cogitator({ llm: { backends: { mock }, retry: false } });

    const result = await processAgentJob(
      {
        type: 'agent',
        jobId: 'j1',
        agentConfig: serializeAgent(agent),
        input: 'A pitch',
        threadId: 't1',
      },
      { cogitator }
    );

    expect(result.structured).toEqual({ verdict: 'run', reason: 'Fresh and important.' });
    expect(result.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cost: 0.0042,
    });
    expect(result.tokenUsage).toEqual({ prompt: 120, completion: 30, total: 150 });
    await cogitator.close();
  });

  it('leaves structured out when the answer does not fit the schema', async () => {
    const mock = new MockLLMBackend().setResponse({ content: '{"verdict":"maybe"}' });
    const cogitator = new Cogitator({ llm: { backends: { mock }, retry: false } });

    const result = await processAgentJob(
      {
        type: 'agent',
        jobId: 'j2',
        agentConfig: serializeAgent(agent),
        input: 'A pitch',
        threadId: 't2',
      },
      { cogitator }
    );

    expect(result).not.toHaveProperty('structured');
    await cogitator.close();
  });
});

describe('resolveRedisOptions', () => {
  it('reads a url with credentials, a database and TLS, explicit fields winning', () => {
    expect(resolveRedisOptions({ url: 'rediss://news:p%40ss@cache.example:6380/3' })).toEqual({
      host: 'cache.example',
      port: 6380,
      username: 'news',
      password: 'p@ss',
      db: 3,
      tls: {},
    });
    expect(resolveRedisOptions({ url: 'redis://cache.example', db: 5, port: 7000 })).toEqual({
      host: 'cache.example',
      port: 7000,
      db: 5,
    });
    expect(resolveRedisOptions({})).toEqual({ host: 'localhost', port: 6379 });
  });

  it('refuses a url that is not redis', () => {
    expect(() => resolveRedisOptions({ url: 'http://cache.example' })).toThrow(
      /redis:\/\/ or rediss:\/\//
    );
    expect(() => resolveRedisOptions({ url: 'redis://cache.example/main' })).toThrow(
      /must be a number/
    );
  });
});

describe('redis cluster connections', () => {
  it('give every node the url credentials and TLS', async () => {
    const { createBullConnection } = await import('../connection');
    const connection = createBullConnection({
      url: 'rediss://news:secret@ignored.example:6380',
      cluster: { nodes: [{ host: 'node-1', port: 7000 }] },
    });
    const cluster = connection.connection as unknown as {
      options: { redisOptions: Record<string, unknown> };
    };
    expect(cluster.options.redisOptions).toMatchObject({
      username: 'news',
      password: 'secret',
      tls: {},
    });
    expect(cluster.options.redisOptions).not.toHaveProperty('host');
    await connection.dispose();
  });
});
