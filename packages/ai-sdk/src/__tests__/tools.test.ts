import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { fromAISDKTool, toAISDKTool, convertToolsFromAISDK, convertToolsToAISDK } from '../tools';
import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';

function makeCogitatorTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: z.object({ input: z.string() }),
    execute: vi.fn().mockResolvedValue('result'),
    toJSON(): ToolSchema {
      return {
        name: this.name,
        description: this.description,
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      };
    },
    ...overrides,
  } as Tool;
}

describe('fromAISDKTool', () => {
  it('converts an AI SDK tool with execute to a Cogitator tool', async () => {
    const executeFn = vi.fn().mockResolvedValue(42);
    const aiTool = {
      description: 'Adds numbers',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: executeFn,
    };

    const tool = fromAISDKTool(aiTool, 'adder');

    expect(tool.name).toBe('adder');
    expect(tool.description).toBe('Adds numbers');
    expect(tool.parameters).toBe(aiTool.parameters);

    const ctx: ToolContext = {
      agentId: 'agent1',
      runId: 'run1',
      signal: new AbortController().signal,
    };
    const result = await tool.execute({ a: 1, b: 2 }, ctx);

    expect(result).toBe(42);
    expect(executeFn).toHaveBeenCalledWith(
      { a: 1, b: 2 },
      { toolCallId: 'run1', messages: [], abortSignal: ctx.signal }
    );
  });

  it('uses name from aiTool if toolName not provided', () => {
    const aiTool = {
      name: 'from_ai',
      description: 'desc',
      parameters: z.object({}),
    };

    const tool = fromAISDKTool(aiTool);
    expect(tool.name).toBe('from_ai');
  });

  it('falls back to unnamed_tool when no name', () => {
    const aiTool = {
      description: 'desc',
      parameters: z.object({}),
    };

    const tool = fromAISDKTool(aiTool);
    expect(tool.name).toBe('unnamed_tool');
  });

  it('throws when parameters not defined', () => {
    const aiTool = { description: 'no params' };
    expect(() => fromAISDKTool(aiTool as never)).toThrow('must have parameters defined');
  });

  it('throws when execute is called but tool has no execute fn', async () => {
    const aiTool = {
      description: 'no exec',
      parameters: z.object({}),
    };

    const tool = fromAISDKTool(aiTool, 'no_exec');
    const ctx: ToolContext = { agentId: 'a', runId: 'r', signal: new AbortController().signal };

    await expect(tool.execute({}, ctx)).rejects.toThrow('has no execute function');
  });

  it('toJSON returns correct ToolSchema', () => {
    const params = z.object({ x: z.number() });
    const aiTool = {
      description: 'test',
      parameters: params,
    };

    const tool = fromAISDKTool(aiTool, 'json_test');
    const json = tool.toJSON();

    expect(json.name).toBe('json_test');
    expect(json.description).toBe('test');
  });

  it('uses default description when not provided', () => {
    const aiTool = {
      parameters: z.object({}),
    };

    const tool = fromAISDKTool(aiTool, 'nodesc');
    expect(tool.description).toBe('AI SDK tool');
  });
});

describe('toAISDKTool', () => {
  it('converts a Cogitator tool to AI SDK format', async () => {
    const executeFn = vi.fn().mockResolvedValue('hello');
    const cogTool = makeCogitatorTool({ execute: executeFn });

    const aiTool = toAISDKTool(cogTool);

    expect(aiTool.description).toBe('A test tool');
    expect(aiTool.parameters).toBe(cogTool.parameters);

    const result = await aiTool.execute!(
      { input: 'test' },
      { toolCallId: 'tc1', messages: [], abortSignal: new AbortController().signal }
    );

    expect(result).toBe('hello');
    expect(executeFn).toHaveBeenCalledWith(
      { input: 'test' },
      expect.objectContaining({ agentId: 'ai-sdk', runId: 'tc1' })
    );
  });

  it('creates AbortController signal when none provided', async () => {
    const executeFn = vi.fn().mockResolvedValue(null);
    const cogTool = makeCogitatorTool({ execute: executeFn });

    const aiTool = toAISDKTool(cogTool);
    await aiTool.execute!({ input: 'x' }, { toolCallId: 'tc2', messages: [] });

    const ctx = executeFn.mock.calls[0][1] as ToolContext;
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('convertToolsFromAISDK', () => {
  it('converts a record of AI SDK tools to array of Cogitator tools', () => {
    const aiTools = {
      add: {
        description: 'Adds',
        parameters: z.object({ a: z.number() }),
        execute: vi.fn(),
      },
      sub: {
        description: 'Subtracts',
        parameters: z.object({ b: z.number() }),
        execute: vi.fn(),
      },
    };

    const tools = convertToolsFromAISDK(aiTools);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('add');
    expect(tools[1].name).toBe('sub');
  });

  it('handles empty record', () => {
    expect(convertToolsFromAISDK({})).toHaveLength(0);
  });
});

describe('convertToolsToAISDK', () => {
  it('converts array of Cogitator tools to record', () => {
    const tools = [makeCogitatorTool({ name: 'tool_a' }), makeCogitatorTool({ name: 'tool_b' })];

    const result = convertToolsToAISDK(tools);

    expect(Object.keys(result)).toEqual(['tool_a', 'tool_b']);
    expect(result.tool_a.description).toBe('A test tool');
    expect(result.tool_b.description).toBe('A test tool');
  });

  it('handles empty array', () => {
    expect(Object.keys(convertToolsToAISDK([]))).toHaveLength(0);
  });
});
