import { describe, it, expect, vi } from 'vitest';
import { SelfModifyingAgent } from '../self-modifying-agent';
import type {
  Agent,
  LLMBackend,
  Tool,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from '@cogitator-ai/types';
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
    id: 'resp',
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

const ADD_TOOL_JSON = JSON.stringify({
  name: 'add_numbers',
  description: 'Add two numbers',
  implementation:
    "async function execute(params) { if (typeof params.a !== 'number' || typeof params.b !== 'number') { throw new Error('a and b must be numbers'); } return params.a + params.b; }",
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
});

const ADD_GAP_JSON = JSON.stringify({
  hasGap: true,
  gaps: [
    {
      id: 'gap_add',
      description: 'Add two numbers',
      requiredCapability: 'a + b',
      suggestedToolName: 'add_numbers',
      complexity: 'simple',
      confidence: 0.95,
    },
  ],
  canProceed: false,
});

interface RouterReplies {
  gap?: string;
  tool?: string;
  profile?: string;
  candidates?: string;
  meta?: string;
  agent: (request: ChatRequest) => ChatResponse;
}

function routedLLM(replies: RouterReplies): LLMBackend & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
    const system = String(request.messages[0]?.content ?? '');
    if (system.includes('capability analyzer')) return chatResponse(replies.gap ?? '{"gaps":[]}');
    if (system.includes('You generate JavaScript tools')) return chatResponse(replies.tool ?? '');
    if (system.includes('task analysis expert')) return chatResponse(replies.profile ?? '{}');
    if (system.includes('architecture optimizer')) return chatResponse(replies.candidates ?? '[]');
    if (system.includes('meta-reasoning system')) return chatResponse(replies.meta ?? '{}');
    return replies.agent(request);
  });
  return {
    provider: 'ollama',
    chat,
    chatStream: async function* () {
      yield { id: 'x', delta: {} };
    },
  };
}

function agentCalls(llm: { chat: ReturnType<typeof vi.fn> }): ChatRequest[] {
  return llm.chat.mock.calls
    .map((call) => call[0] as ChatRequest)
    .filter((req) => String(req.messages[0]?.content) === 'You are a test assistant.');
}

const quietConfig = {
  toolGeneration: { enabled: false },
  metaReasoning: { enabled: false },
  architectureEvolution: { enabled: false },
  constraints: { enabled: false },
};

describe('SelfModifyingAgent run semantics', () => {
  it('completes a short answer with a single LLM call even with meta-reasoning enabled', async () => {
    const llm = routedLLM({ agent: () => chatResponse('4') });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent(),
      llm,
      config: {
        toolGeneration: { enabled: false },
        architectureEvolution: { enabled: false },
      },
    });

    const result = await selfMod.run('What is 2 + 2?');

    expect(result.output).toBe('4');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('skips every self-modification step when disabled globally', async () => {
    const llm = routedLLM({
      gap: ADD_GAP_JSON,
      tool: ADD_TOOL_JSON,
      agent: () => chatResponse('ok'),
    });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent(),
      llm,
      config: { enabled: false },
    });

    const result = await selfMod.run('add 1 and 2');

    expect(result.output).toBe('ok');
    expect(result.toolsGenerated).toEqual([]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('uses the agent temperature and max tokens as the baseline config', async () => {
    const llm = routedLLM({ agent: () => chatResponse('done') });
    const agent = { ...createMockAgent(), config: { temperature: 0.15, maxTokens: 321 } } as Agent;
    const selfMod = new SelfModifyingAgent({ agent, llm, config: quietConfig });

    const result = await selfMod.run('hi');

    expect(llm.chat.mock.calls[0][0]).toMatchObject({ temperature: 0.15, maxTokens: 321 });
    expect(result.finalConfig).toMatchObject({ temperature: 0.15, maxTokens: 321 });
  });

  it('validates tool arguments against the tool schema before executing', async () => {
    const calculator = createMockTool('calculator', 42);
    const llm = routedLLM({
      agent: vi
        .fn()
        .mockReturnValueOnce(
          chatResponse('', [{ id: 'c1', name: 'calculator', arguments: { input: 7 } }])
        )
        .mockReturnValueOnce(chatResponse('could not compute')),
    });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent([calculator]),
      llm,
      config: quietConfig,
    });

    await selfMod.run('compute');

    expect(calculator.execute).not.toHaveBeenCalled();
    const toolMessage = llm.chat.mock.calls[1][0].messages.find(
      (m: { role: string }) => m.role === 'tool'
    );
    expect(toolMessage.content).toContain('Invalid arguments');
  });

  it('serializes concurrent runs so contexts never mix', async () => {
    let resolveFirst: ((value: ChatResponse) => void) | undefined;
    const llm = routedLLM({
      agent: (request) => {
        const input = String(request.messages[request.messages.length - 1].content);
        if (input === 'first') {
          return new Promise<ChatResponse>((resolve) => {
            resolveFirst = resolve;
          }) as unknown as ChatResponse;
        }
        return chatResponse(`answer:${input}`);
      },
    });
    const selfMod = new SelfModifyingAgent({ agent: createMockAgent(), llm, config: quietConfig });

    const first = selfMod.run('first');
    const second = selfMod.run('second');
    await vi.waitFor(() => expect(resolveFirst).toBeDefined());
    expect(llm.chat).toHaveBeenCalledTimes(1);

    resolveFirst!(chatResponse('answer:first'));

    await expect(first).resolves.toMatchObject({ output: 'answer:first' });
    await expect(second).resolves.toMatchObject({ output: 'answer:second' });
  });

  it('provides typed events and an unsubscribe function', async () => {
    const llm = routedLLM({ agent: () => chatResponse('done') });
    const selfMod = new SelfModifyingAgent({ agent: createMockAgent(), llm, config: quietConfig });
    const inputs: string[] = [];

    const unsubscribe = selfMod.on('run_started', (event) => {
      inputs.push(event.data.input);
    });
    await selfMod.run('one');
    unsubscribe();
    await selfMod.run('two');

    expect(inputs).toEqual(['one']);
  });
});

describe('SelfModifyingAgent tool generation', () => {
  it('activates accepted tools, exposes them to the LLM and keeps them for later runs', async () => {
    const llm = routedLLM({
      gap: ADD_GAP_JSON,
      tool: ADD_TOOL_JSON,
      agent: (request) => {
        const hasToolResult = request.messages.some((m) => m.role === 'tool');
        if (!hasToolResult && request.tools?.some((t) => t.name === 'add_numbers')) {
          return chatResponse('', [{ id: 'c1', name: 'add_numbers', arguments: { a: 2, b: 3 } }]);
        }
        return chatResponse('The sum is 5');
      },
    });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent(),
      llm,
      config: {
        toolGeneration: { requireLLMValidation: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
      },
    });

    const first = await selfMod.run('Add 2 and 3');

    expect(first.output).toBe('The sum is 5');
    expect(first.toolsGenerated.map((t) => t.name)).toEqual(['add_numbers']);
    const active = await selfMod.getGeneratedTools();
    expect(active.map((t) => t.status)).toEqual(['active']);

    const toolMessage = agentCalls(llm)
      .flatMap((r) => r.messages)
      .find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('5');

    const firstSchema = agentCalls(llm)[0].tools?.find((t) => t.name === 'add_numbers');
    expect(firstSchema?.parameters).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    });

    llm.chat.mockClear();
    await selfMod.run('Add 2 and 3 again');
    expect(agentCalls(llm)[0].tools?.map((t) => t.name)).toContain('add_numbers');
  });

  it('does not store tools rejected by modification constraints', async () => {
    const llm = routedLLM({
      gap: ADD_GAP_JSON,
      tool: ADD_TOOL_JSON,
      agent: () => chatResponse('ok'),
    });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent(),
      llm,
      config: {
        toolGeneration: { requireLLMValidation: false, sandboxConfig: { enabled: false } },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
      },
    });
    const completed: Array<{ success: boolean; error?: string }> = [];
    selfMod.on('tool_generation_completed', (e) => completed.push(e.data));

    const result = await selfMod.run('Add 2 and 3');

    expect(result.toolsGenerated).toEqual([]);
    expect(await selfMod.getGeneratedTools()).toEqual([]);
    expect(completed).toEqual([
      expect.objectContaining({ success: false, error: 'Rejected by modification constraints' }),
    ]);
  });
});

describe('SelfModifyingAgent meta-reasoning', () => {
  it('retries failed steps with the adapted reasoning mode', async () => {
    const llm = routedLLM({
      meta: JSON.stringify({
        onTrack: false,
        confidence: 0.3,
        recommendation: {
          action: 'switch_mode',
          newMode: 'creative',
          confidence: 0.9,
          reasoning: 'try a different approach',
        },
      }),
      agent: vi.fn().mockReturnValueOnce(chatResponse('')).mockReturnValueOnce(chatResponse('42')),
    });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent(),
      llm,
      config: {
        toolGeneration: { enabled: false },
        architectureEvolution: { enabled: false },
        metaReasoning: { metaAssessmentCooldown: 0, adaptationCooldown: 0 },
      },
    });
    const modes: string[] = [];
    selfMod.on('strategy_changed', (e) => modes.push(`${e.data.previousMode}->${e.data.newMode}`));

    const result = await selfMod.run('answer');
    const calls = agentCalls(llm);

    expect(result.output).toBe('42');
    expect(calls.map((c) => c.temperature)).toEqual([0.5, 0.9]);
    expect(result.adaptationsMade).toHaveLength(1);
    expect(modes).toEqual(['analytical->analytical', 'analytical->creative']);
  });
});

describe('SelfModifyingAgent architecture evolution', () => {
  it('applies config changes and records outcomes so candidates get evaluated', async () => {
    const llm = routedLLM({
      profile: JSON.stringify({ complexity: 'simple', domain: 'general' }),
      candidates: JSON.stringify([
        { id: 'cool', config: { temperature: 0.2, reflectionDepth: 1 }, risk: 'low' },
      ]),
      agent: () => chatResponse('answer'),
    });
    const selfMod = new SelfModifyingAgent({
      agent: createMockAgent(),
      llm,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { strategy: { type: 'ucb' } },
      },
    });
    const evolved: Array<string | undefined> = [];
    selfMod.on('architecture_evolved', (e) => evolved.push(e.data.candidateId));

    const first = await selfMod.run('task');
    expect(first.finalConfig.temperature).toBe(0.5);

    llm.chat.mockClear();
    const second = await selfMod.run('task');

    expect(second.finalConfig).toMatchObject({ temperature: 0.2, reflectionDepth: 1 });
    expect(evolved).toEqual(['cool']);
    const calls = agentCalls(llm);
    expect(calls).toHaveLength(2);
    expect(String(calls[1].messages[calls[1].messages.length - 1].content)).toContain(
      'Review your previous answer'
    );
  });
});

describe('SelfModifyingAgent model resolution', () => {
  it('strips the backend provider prefix from the agent model', async () => {
    const llm = routedLLM({ agent: () => chatResponse('done') });
    const agent = { ...createMockAgent(), model: 'ollama/llama3.2' } as Agent;
    const selfMod = new SelfModifyingAgent({ agent, llm, config: quietConfig });

    const result = await selfMod.run('hi');

    expect(llm.chat.mock.calls[0][0].model).toBe('llama3.2');
    expect(result.finalConfig.model).toBe('llama3.2');
  });

  it('keeps model names whose prefix belongs to another provider', async () => {
    const llm = routedLLM({ agent: () => chatResponse('done') });
    const agent = { ...createMockAgent(), model: 'openai/gpt-4o' } as Agent;
    const selfMod = new SelfModifyingAgent({ agent, llm, config: quietConfig });

    await selfMod.run('hi');

    expect(llm.chat.mock.calls[0][0].model).toBe('openai/gpt-4o');
  });
});
