import { describe, it, expect } from 'vitest';
import {
  toAISDKTool,
  fromAISDKTool,
  convertToolsToAISDK,
  convertToolsFromAISDK,
} from '@cogitator-ai/ai-sdk';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const multiply = tool({
  name: 'multiply',
  description: 'Multiply two numbers',
  parameters: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  }),
  execute: async ({ a, b }) => ({ result: a * b }),
});

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  parameters: z.object({
    a: z.number(),
    b: z.number(),
  }),
  execute: async ({ a, b }) => ({ result: a + b }),
});

const greet = tool({
  name: 'greet',
  description: 'Greet a person',
  parameters: z.object({
    name: z.string(),
    excited: z.boolean().optional(),
  }),
  execute: async ({ name, excited }) => {
    const suffix = excited ? '!' : '.';
    return { message: `Hello, ${name}${suffix}` };
  },
});

const ctx = { agentId: 'test', runId: 'test-run', signal: AbortSignal.timeout(5000) };
const aiSdkOptions = { toolCallId: 'call-1', messages: [] };

describe('AI SDK: Tool Adapter', () => {
  it('toAISDKTool converts Cogitator tool to AI SDK format', () => {
    const converted = toAISDKTool(multiply);

    expect(converted.description).toBe('Multiply two numbers');
    expect(converted.parameters).toBeDefined();
    expect(converted.execute).toBeTypeOf('function');
  });

  it('fromAISDKTool converts AI SDK tool back to Cogitator format', () => {
    const aiTool = {
      description: 'Subtract two numbers',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async (params: unknown) => {
        const { a, b } = params as { a: number; b: number };
        return { result: a - b };
      },
    };

    const converted = fromAISDKTool(aiTool, 'subtract');

    expect(converted.name).toBe('subtract');
    expect(converted.description).toBe('Subtract two numbers');
    expect(converted.parameters).toBeDefined();
    expect(converted.execute).toBeTypeOf('function');
  });

  it('converted tool executes correctly', async () => {
    const converted = toAISDKTool(multiply);

    const result = await converted.execute!({ a: 3, b: 7 }, aiSdkOptions);

    expect(result).toEqual({ result: 21 });
  });

  it('batch conversion preserves all tools', () => {
    const cogTools = [multiply, add, greet];
    const aiTools = convertToolsToAISDK(cogTools);

    expect(Object.keys(aiTools)).toHaveLength(3);
    expect(aiTools).toHaveProperty('multiply');
    expect(aiTools).toHaveProperty('add');
    expect(aiTools).toHaveProperty('greet');

    expect(aiTools.multiply.description).toBe('Multiply two numbers');
    expect(aiTools.add.description).toBe('Add two numbers');
    expect(aiTools.greet.description).toBe('Greet a person');
  });

  it('batch conversion from AI SDK preserves names', () => {
    const aiTools: Record<
      string,
      {
        description: string;
        parameters: unknown;
        execute?: (
          params: unknown,
          options: { toolCallId: string; messages: unknown[] }
        ) => Promise<unknown>;
      }
    > = {
      double: {
        description: 'Double a number',
        parameters: z.object({ n: z.number() }),
        execute: async (params: unknown) => {
          const { n } = params as { n: number };
          return { result: n * 2 };
        },
      },
      negate: {
        description: 'Negate a number',
        parameters: z.object({ n: z.number() }),
        execute: async (params: unknown) => {
          const { n } = params as { n: number };
          return { result: -n };
        },
      },
    };

    const cogTools = convertToolsFromAISDK(aiTools);

    expect(cogTools).toHaveLength(2);
    const names = cogTools.map((t) => t.name);
    expect(names).toContain('double');
    expect(names).toContain('negate');
  });

  it('round-trip conversion preserves behavior', async () => {
    const aiVersion = toAISDKTool(multiply);
    const roundTripped = fromAISDKTool(
      {
        description: aiVersion.description,
        parameters: aiVersion.parameters,
        execute: aiVersion.execute as (
          params: unknown,
          options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
        ) => Promise<unknown>,
      },
      'multiply'
    );

    const input = { a: 6, b: 7 };
    const originalResult = await multiply.execute(input, ctx);
    const roundTrippedResult = await roundTripped.execute(input as never, ctx);

    expect(roundTrippedResult).toEqual(originalResult);
    expect(roundTrippedResult).toEqual({ result: 42 });
  });

  it('fromAISDKTool uses fallback name when none provided', () => {
    const aiTool = {
      description: 'Some tool',
      parameters: z.object({ x: z.number() }),
    };

    const converted = fromAISDKTool(aiTool);
    expect(converted.name).toBe('unnamed_tool');
  });

  it('fromAISDKTool prefers explicit name over tool.name', () => {
    const aiTool = {
      name: 'original_name',
      description: 'A tool',
      parameters: z.object({ x: z.number() }),
    };

    const converted = fromAISDKTool(aiTool, 'override_name');
    expect(converted.name).toBe('override_name');
  });

  it('fromAISDKTool throws when parameters are missing', () => {
    const aiTool = { description: 'No params' };

    expect(() => fromAISDKTool(aiTool as never)).toThrow(
      'AI SDK tool must have parameters defined'
    );
  });

  it('converted AI SDK tool without execute returns undefined', async () => {
    const aiTool = {
      description: 'Declaration only',
      parameters: z.object({ x: z.number() }),
    };

    const converted = fromAISDKTool(aiTool, 'declarative');
    const result = await converted.execute({ x: 1 } as never, ctx);

    expect(result).toBeUndefined();
  });

  it('toJSON works on fromAISDKTool result', () => {
    const aiTool = {
      description: 'Square a number',
      parameters: z.object({ n: z.number() }),
      execute: async (params: unknown) => {
        const { n } = params as { n: number };
        return { result: n * n };
      },
    };

    const converted = fromAISDKTool(aiTool, 'square');
    const schema = converted.toJSON();

    expect(schema.name).toBe('square');
    expect(schema.description).toBe('Square a number');
  });
});
