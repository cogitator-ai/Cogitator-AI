import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { ToolContext } from '@cogitator-ai/types';
import { jsonSchema as jsonSchemaV7, tool as aiToolV7 } from 'ai';
import { jsonSchema as jsonSchemaV4 } from 'ai-v4';
import { fromAISDKTool, toAISDKTool, convertToolsFromAISDK, convertToolsToAISDK } from '../tools';

const ctx: ToolContext = {
  agentId: 'agent1',
  runId: 'run1',
  signal: new AbortController().signal,
  threadId: 'thread1',
};

const AI_SDK_SCHEMA = Symbol.for('vercel.ai.schema');
const AI_SDK_VALIDATOR = Symbol.for('vercel.ai.validator');

function makeCogitatorTool(execute = vi.fn().mockResolvedValue('result')) {
  return tool({
    name: 'test_tool',
    description: 'A test tool',
    parameters: z.object({ input: z.string(), count: z.number().default(1) }),
    execute,
  });
}

describe('fromAISDKTool', () => {
  it('keeps zod 4 schemas and passes the Cogitator context to execute', async () => {
    const executeFn = vi.fn().mockResolvedValue(42);
    const aiTool = {
      description: 'Adds numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: executeFn,
    };

    const converted = fromAISDKTool(aiTool, 'adder');

    expect(converted.name).toBe('adder');
    expect(converted.description).toBe('Adds numbers');
    expect(converted.parameters).toBe(aiTool.inputSchema);
    expect(converted.toJSON().parameters).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    });

    expect(await converted.execute({ a: 1, b: 2 }, ctx)).toBe(42);
    const context = { agentId: 'agent1', runId: 'run1', threadId: 'thread1' };
    expect(executeFn).toHaveBeenCalledWith(
      { a: 1, b: 2 },
      {
        toolCallId: 'run1',
        messages: [],
        abortSignal: ctx.signal,
        context,
        experimental_context: context,
      }
    );
  });

  it('accepts ai@4 tools that define parameters', () => {
    const converted = fromAISDKTool({ parameters: z.object({ x: z.number() }) }, 'legacy');
    expect(converted.toJSON().parameters.properties).toEqual({ x: { type: 'number' } });
  });

  it('converts jsonSchema() schemas and validates input before execute', async () => {
    const executeFn = vi.fn().mockResolvedValue('ok');
    const schema = jsonSchemaV7<{ city: string }>(
      { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      {
        validate: (value) =>
          typeof (value as { city?: unknown }).city === 'string'
            ? { success: true, value: value as { city: string } }
            : { success: false, error: new Error('city is required') },
      }
    );

    const converted = fromAISDKTool({ inputSchema: schema, execute: executeFn }, 'weather');

    expect(converted.toJSON().parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
    await expect(converted.execute({} as never, ctx)).rejects.toThrow('city is required');
    await expect(converted.execute({ city: 'Paris' } as never, ctx)).resolves.toBe('ok');
  });

  it('converts ai@4 jsonSchema() schemas', () => {
    const schema = jsonSchemaV4({ type: 'object', properties: { id: { type: 'number' } } });
    const converted = fromAISDKTool({ parameters: schema }, 'lookup');
    expect(converted.toJSON().parameters.properties).toEqual({ id: { type: 'number' } });
  });

  it('resolves ai@7 tools with a dynamic description and streaming execute', async () => {
    const aiTool = aiToolV7({
      description: () => 'Counts up',
      inputSchema: z.object({ to: z.number() }),
      async *execute({ to }) {
        for (let i = 1; i <= to; i++) yield i;
      },
    });

    const converted = fromAISDKTool(aiTool, 'counter');

    expect(converted.description).toBe('Counts up');
    await expect(converted.execute({ to: 3 } as never, ctx)).resolves.toBe(3);
  });

  it('uses the tool name, then a fallback name', () => {
    expect(fromAISDKTool({ name: 'from_ai', parameters: z.object({}) }).name).toBe('from_ai');
    expect(fromAISDKTool({ parameters: z.object({}) }).name).toBe('unnamed_tool');
    expect(fromAISDKTool({ parameters: z.object({}) }).description).toBe('AI SDK tool');
  });

  it('throws when no schema is defined', () => {
    expect(() => fromAISDKTool({ description: 'no params' })).toThrow(
      'AI SDK tool must have parameters defined'
    );
  });

  it('throws for schemas that cannot be converted to JSON Schema', () => {
    expect(() => fromAISDKTool({ inputSchema: 42 }, 'bad')).toThrow('unsupported input schema');
  });

  it('throws when executed without an execute function', async () => {
    const converted = fromAISDKTool({ parameters: z.object({}) }, 'no_exec');
    await expect(converted.execute({}, ctx)).rejects.toThrow('has no execute function');
  });
});

describe('toAISDKTool', () => {
  it('exposes the zod schema as inputSchema (ai@5+) and an AI SDK Schema as parameters (ai@4)', () => {
    const cogTool = makeCogitatorTool();
    const aiTool = toAISDKTool(cogTool);
    const expectedJSONSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { input: { type: 'string' }, count: { type: 'number', default: 1 } },
      required: ['input'],
    };

    expect(aiTool.description).toBe('A test tool');
    expect(aiTool.inputSchema).toBe(cogTool.parameters);
    expect(aiTool.parameters.jsonSchema).toEqual(expectedJSONSchema);
    expect(aiTool.parameters['~standard'].jsonSchema.input({ target: 'draft-07' })).toEqual(
      expectedJSONSchema
    );
    expect((aiTool.parameters as unknown as Record<symbol, unknown>)[AI_SDK_SCHEMA]).toBe(true);
    expect((aiTool.parameters as unknown as Record<symbol, unknown>)[AI_SDK_VALIDATOR]).toBe(true);
  });

  it('validates synchronously with the Cogitator schema', () => {
    const { parameters: inputSchema } = toAISDKTool(makeCogitatorTool());

    expect(inputSchema.validate({ input: 'x' })).toEqual({
      success: true,
      value: { input: 'x', count: 1 },
    });
    const invalid = inputSchema.validate({ input: 1 });
    expect(invalid).toMatchObject({ success: false });
    expect(inputSchema['~standard'].validate({ input: 'x' })).toEqual({
      value: { input: 'x', count: 1 },
    });
  });

  it('maps AI SDK execute options to a Cogitator tool context', async () => {
    const executeFn = vi.fn().mockResolvedValue('hello');
    const aiTool = toAISDKTool(makeCogitatorTool(executeFn));
    const signal = new AbortController().signal;

    await expect(
      aiTool.execute(
        { input: 'test', count: 1 },
        { toolCallId: 'tc1', messages: [], abortSignal: signal, context: { userId: 'u1', n: 1 } }
      )
    ).resolves.toBe('hello');

    expect(executeFn).toHaveBeenCalledWith(
      { input: 'test', count: 1 },
      {
        agentId: 'ai-sdk',
        runId: 'tc1',
        signal,
        threadId: undefined,
        userId: 'u1',
        channelType: undefined,
        channelId: undefined,
      }
    );
  });

  it('reads experimental_context and creates a signal when none is provided', async () => {
    const executeFn = vi.fn().mockResolvedValue(null);
    const aiTool = toAISDKTool(makeCogitatorTool(executeFn));

    await aiTool.execute(
      { input: 'x', count: 1 },
      { toolCallId: 'tc2', messages: [], experimental_context: { threadId: 't9' } }
    );

    const context = executeFn.mock.calls[0][1] as ToolContext;
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.threadId).toBe('t9');
  });

  it('round-trips through fromAISDKTool', async () => {
    const cogTool = makeCogitatorTool(vi.fn(async ({ input }: { input: string }) => input.length));
    const roundTripped = fromAISDKTool(toAISDKTool(cogTool), 'test_tool');

    expect(roundTripped.toJSON()).toEqual(cogTool.toJSON());
    await expect(roundTripped.execute({ input: 'abcd' } as never, ctx)).resolves.toBe(4);
  });
});

describe('batch conversion', () => {
  it('converts a record of AI SDK tools to Cogitator tools', () => {
    const tools = convertToolsFromAISDK({
      add: { description: 'Adds', inputSchema: z.object({ a: z.number() }), execute: vi.fn() },
      sub: { description: 'Subtracts', parameters: z.object({ b: z.number() }), execute: vi.fn() },
    });

    expect(tools.map((t) => t.name)).toEqual(['add', 'sub']);
    expect(convertToolsFromAISDK({})).toHaveLength(0);
  });

  it('converts Cogitator tools to a record of AI SDK tools', () => {
    const result = convertToolsToAISDK([
      tool({ ...makeCogitatorTool(), name: 'tool_a' }),
      tool({ ...makeCogitatorTool(), name: 'tool_b' }),
    ]);

    expect(Object.keys(result)).toEqual(['tool_a', 'tool_b']);
    expect(result.tool_a.description).toBe('A test tool');
    expect(convertToolsToAISDK([])).toEqual({});
  });
});
