import { describe, it, expect, vi } from 'vitest';
import { SelfModifyingAgent } from '../self-modifying-agent';
import type { Agent, LLMBackend, Tool, ChatResponse, ToolCall } from '@cogitator-ai/types';
import { z } from 'zod';

function createMockAgent(tools: Tool[] = []): Agent {
  return {
    name: 'test-agent',
    model: 'test-model',
    instructions: 'You are a test assistant.',
    tools,
    config: { temperature: 0.5 },
  } as Agent;
}

function createMockTool(name: string, result: unknown): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: z.object({ input: z.string() }),
    execute: vi.fn().mockResolvedValue(result),
    toJSON: () => ({
      name,
      description: `Mock tool: ${name}`,
      parameters: { type: 'object' as const, properties: { input: { type: 'string' } } },
    }),
  };
}

function chatResponse(content: string, toolCalls?: ToolCall[]): ChatResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  };
}

describe('SelfModifyingAgent tool execution', () => {
  it('passes tools to LLM and returns response', async () => {
    const calculator = createMockTool('calculator', { result: 42 });

    const mockLLM: Partial<LLMBackend> = {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          chatResponse('', [{ id: 'call_1', name: 'calculator', arguments: { input: '6*7' } }])
        )
        .mockResolvedValueOnce(
          chatResponse(
            'The answer to your calculation is 42. I used the calculator tool to compute 6 times 7.'
          )
        ),
    };

    const agent = createMockAgent([calculator]);
    const selfMod = new SelfModifyingAgent({
      agent,
      llm: mockLLM as LLMBackend,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
        constraints: { enabled: false },
      },
    });

    const result = await selfMod.run('What is 6 times 7?');

    expect(result.output).toBe(
      'The answer to your calculation is 42. I used the calculator tool to compute 6 times 7.'
    );
    expect(calculator.execute).toHaveBeenCalledOnce();
    expect(calculator.execute).toHaveBeenCalledWith(
      { input: '6*7' },
      expect.objectContaining({ agentId: 'test-agent' })
    );

    const chatCalls = vi.mocked(mockLLM.chat!).mock.calls;
    expect(chatCalls[0][0].tools).toBeDefined();
    expect(chatCalls[0][0].tools).toHaveLength(1);
    expect(chatCalls[0][0].tools![0].name).toBe('calculator');
  });

  it('handles multiple sequential tool calls', async () => {
    const search = createMockTool('search', { results: ['found it'] });
    const format = createMockTool('format', { text: 'formatted result' });

    const mockLLM: Partial<LLMBackend> = {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          chatResponse('', [{ id: 'call_1', name: 'search', arguments: { input: 'test' } }])
        )
        .mockResolvedValueOnce(
          chatResponse('', [{ id: 'call_2', name: 'format', arguments: { input: 'found it' } }])
        )
        .mockResolvedValueOnce(
          chatResponse(
            'Here is your formatted result. I searched for the information and then formatted it for you.'
          )
        ),
    };

    const agent = createMockAgent([search, format]);
    const selfMod = new SelfModifyingAgent({
      agent,
      llm: mockLLM as LLMBackend,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
        constraints: { enabled: false },
      },
    });

    const result = await selfMod.run('Search and format');

    expect(result.output).toBe(
      'Here is your formatted result. I searched for the information and then formatted it for you.'
    );
    expect(search.execute).toHaveBeenCalledOnce();
    expect(format.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(mockLLM.chat!)).toHaveBeenCalledTimes(3);
  });

  it('handles tool execution errors gracefully', async () => {
    const failTool = createMockTool('broken', null);
    (failTool.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tool crashed'));

    const mockLLM: Partial<LLMBackend> = {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          chatResponse('', [{ id: 'call_1', name: 'broken', arguments: { input: 'test' } }])
        )
        .mockResolvedValueOnce(
          chatResponse(
            'The tool failed but I can still help you with your request. Let me try a different approach.'
          )
        ),
    };

    const agent = createMockAgent([failTool]);
    const selfMod = new SelfModifyingAgent({
      agent,
      llm: mockLLM as LLMBackend,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
        constraints: { enabled: false },
      },
    });

    const result = await selfMod.run('Use the broken tool');

    expect(result.output).toBe(
      'The tool failed but I can still help you with your request. Let me try a different approach.'
    );
    const secondCall = vi.mocked(mockLLM.chat!).mock.calls[1][0];
    const toolMsg = secondCall.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg?.content).toContain('tool crashed');
  });

  it('handles unknown tool calls', async () => {
    const mockLLM: Partial<LLMBackend> = {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          chatResponse('', [{ id: 'call_1', name: 'nonexistent', arguments: { input: 'x' } }])
        )
        .mockResolvedValueOnce(
          chatResponse(
            'I could not find that tool in my available tools. Let me try to help you without it.'
          )
        ),
    };

    const agent = createMockAgent([]);
    const selfMod = new SelfModifyingAgent({
      agent,
      llm: mockLLM as LLMBackend,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
        constraints: { enabled: false },
      },
    });

    const result = await selfMod.run('Call a tool');

    expect(result.output).toBe(
      'I could not find that tool in my available tools. Let me try to help you without it.'
    );
    const secondCall = vi.mocked(mockLLM.chat!).mock.calls[1][0];
    const toolMsg = secondCall.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg?.content).toContain('not found');
  });

  it('works without any tools (no tools passed to LLM)', async () => {
    const mockLLM: Partial<LLMBackend> = {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          chatResponse(
            'Hello world! I am a test assistant and I am here to help you with your questions.'
          )
        ),
    };

    const agent = createMockAgent([]);
    const selfMod = new SelfModifyingAgent({
      agent,
      llm: mockLLM as LLMBackend,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
        constraints: { enabled: false },
      },
    });

    const result = await selfMod.run('Just say hi');

    expect(result.output).toBe(
      'Hello world! I am a test assistant and I am here to help you with your questions.'
    );
    const chatCall = vi.mocked(mockLLM.chat!).mock.calls[0][0];
    expect(chatCall.tools).toBeUndefined();
  });
});
