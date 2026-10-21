import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  CogitatorError,
  type ChatRequest,
  type ChatResponse,
  type ClearToolOutputsConfig,
  type CogitatorConfig,
  type LLMBackend,
  type Message,
  type ModelTurnUpdate,
  type RunMiddleware,
  type RunMiddlewareContext,
  type ToolCall,
  type ToolResult,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { ContextManager } from '../context/index';
import {
  clearToolOutputsMiddleware,
  clearedOutputNote,
  isClearedArguments,
} from '../middleware/index';
import { RECALL_TOOL_OUTPUT, recallToolOutputTool } from '../tools/recall-tool-output';
import { createToolContext } from './helpers/tool-context';

const BIG = 'x'.repeat(4_000);

interface Output {
  id: string;
  name?: string;
  output?: string;
}

function conversation(outputs: Output[]): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'Help.' },
    { role: 'user', content: 'Research it.' },
  ];
  for (const { id, name = 'fetch', output = BIG } of outputs) {
    const assistant: Message & { toolCalls: ToolCall[] } = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name, arguments: { url: `https://example.com/${id}`, notes: BIG } }],
    };
    messages.push(assistant, { role: 'tool', content: output, toolCallId: id, name });
  }
  return messages;
}

function contextWith(state = new Map<string, unknown>()): RunMiddlewareContext {
  return {
    runId: 'run_1',
    agentId: 'agent_1',
    agentName: 'researcher',
    iteration: 1,
    signal: new AbortController().signal,
    state,
  };
}

async function clear(
  options: ClearToolOutputsConfig,
  messages: Message[],
  context = contextWith()
): Promise<Message[] | undefined> {
  const layer = clearToolOutputsMiddleware(options);
  const update = (await layer.beforeModel?.({ messages, model: 'mock/m' }, context)) as
    ModelTurnUpdate | undefined;
  return update?.messages;
}

function clearedIds(messages: readonly Message[]): string[] {
  return messages
    .filter((m) => m.role === 'tool' && m.content === clearedOutputNote(m.toolCallId ?? ''))
    .map((m) => m.toolCallId ?? '');
}

function callsOf(message: Message): ToolCall[] {
  if (!('toolCalls' in message) || !Array.isArray(message.toolCalls)) return [];
  return message.toolCalls;
}

/** Every tool call has exactly one result after it and every result answers a call before it. */
function expectValidPairs(messages: readonly Message[]): void {
  const open = new Set<string>();
  for (const message of messages) {
    for (const call of callsOf(message)) open.add(call.id);
    if (message.role === 'tool') {
      expect(open.has(message.toolCallId ?? '')).toBe(true);
      open.delete(message.toolCallId ?? '');
    }
  }
  expect(open.size).toBe(0);
}

const ids = (count: number): Output[] =>
  Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}` }));

describe('clearToolOutputsMiddleware', () => {
  it('leaves a conversation below the trigger alone', async () => {
    expect(await clear({ trigger: 1_000_000 }, conversation(ids(5)))).toBeUndefined();
  });

  it('clears every output but the most recent ones once the trigger is reached', async () => {
    const messages = conversation(ids(6));
    const cleared = await clear({ trigger: 100 }, messages);

    expect(clearedIds(cleared ?? [])).toEqual(['c1', 'c2', 'c3']);
    expect(cleared).toHaveLength(messages.length);
    const note = cleared?.find((m) => m.toolCallId === 'c1')?.content;
    expect(note).toContain('"toolCallId":"c1"');
    expect(note).toContain(RECALL_TOOL_OUTPUT);
    expectValidPairs(cleared ?? []);
    expect(messages[3]?.content).toBe(BIG);
  });

  it('keeps as many recent outputs as keep says, none with keep 0', async () => {
    expect(clearedIds((await clear({ trigger: 0, keep: 1 }, conversation(ids(3)))) ?? [])).toEqual([
      'c1',
      'c2',
    ]);
    expect(clearedIds((await clear({ trigger: 0, keep: 0 }, conversation(ids(3)))) ?? [])).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('is off by default at 100 000 tokens and keeps 3', async () => {
    const outputs = Array.from({ length: 60 }, (_, index) => ({ id: `c${index}` }));
    const cleared = await clear({}, conversation(outputs));
    expect(cleared).toBeDefined();
    expect(clearedIds(cleared ?? [])).toHaveLength(57);
    expect(await clear({}, conversation(ids(4)))).toBeUndefined();
  });

  it('never clears the outputs of excluded tools', async () => {
    const messages = conversation([
      { id: 'c1', name: 'read_file' },
      { id: 'c2' },
      { id: 'c3' },
      { id: 'c4' },
    ]);
    const cleared = await clear({ trigger: 0, keep: 1, exclude: ['read_file'] }, messages);
    expect(clearedIds(cleared ?? [])).toEqual(['c2', 'c3']);
  });

  it('skips outputs shorter than the note', async () => {
    const messages = conversation([{ id: 'c1', output: 'ok' }, { id: 'c2' }, { id: 'c3' }]);
    expect(clearedIds((await clear({ trigger: 0, keep: 1 }, messages)) ?? [])).toEqual(['c2']);
  });

  it('keeps the arguments of cleared calls unless clearInputs is set', async () => {
    const kept = await clear({ trigger: 0, keep: 1 }, conversation(ids(2)));
    expect(callsOf(kept?.[2] ?? { role: 'user', content: '' })[0]?.arguments).toMatchObject({
      url: 'https://example.com/c1',
    });

    const messages = conversation(ids(2));
    const cleared = await clear({ trigger: 0, keep: 1, clearInputs: true }, messages);
    const [first] = callsOf(cleared?.[2] ?? { role: 'user', content: '' });
    expect(first?.id).toBe('c1');
    expect(first?.name).toBe('fetch');
    expect(isClearedArguments(first?.arguments ?? {})).toBe(true);
    expect(callsOf(cleared?.[4] ?? { role: 'user', content: '' })[0]?.arguments).toMatchObject({
      url: 'https://example.com/c2',
    });
    expect(callsOf(messages[2] ?? { role: 'user', content: '' })[0]?.arguments.notes).toBe(BIG);
    expectValidPairs(cleared ?? []);
  });

  it('counts the cleared arguments in the tokens it frees', async () => {
    const without = vi.fn();
    const withInputs = vi.fn();
    await clear({ trigger: 0, keep: 1, onBeforeClear: without }, conversation(ids(2)));
    await clear(
      { trigger: 0, keep: 1, clearInputs: true, onBeforeClear: withInputs },
      conversation(ids(2))
    );
    expect(withInputs.mock.calls[0]?.[0].tokensFreed).toBeGreaterThan(
      without.mock.calls[0]?.[0].tokensFreed + 900
    );
  });

  it('clears nothing when it would free fewer than clearAtLeast tokens', async () => {
    const messages = conversation(ids(3));
    expect(await clear({ trigger: 0, keep: 1, clearAtLeast: 5_000 }, messages)).toBeUndefined();
    expect(
      clearedIds((await clear({ trigger: 0, keep: 1, clearAtLeast: 1_500 }, messages)) ?? [])
    ).toEqual(['c1', 'c2']);
  });

  it('does not clear or count an output twice', async () => {
    const onBeforeClear = vi.fn();
    const state = new Map<string, unknown>();
    const options = { trigger: 0, keep: 1, clearAtLeast: 10, onBeforeClear };
    const once = await clear(options, conversation(ids(3)), contextWith(state));
    expect(await clear(options, once ?? [], contextWith(state))).toBeUndefined();

    const more = [...(once ?? []), ...conversation([{ id: 'c4' }]).slice(2)];
    const twice = await clear(options, more, contextWith(state));
    expect(clearedIds(twice ?? [])).toEqual(['c1', 'c2', 'c3']);
    expect(onBeforeClear).toHaveBeenCalledTimes(2);
    expect(
      onBeforeClear.mock.calls[1]?.[0].calls.map((call: { toolCallId: string }) => call.toolCallId)
    ).toEqual(['c3']);
  });

  it('awaits onBeforeClear with the calls about to be cleared before clearing', async () => {
    const order: string[] = [];
    const context = contextWith();
    const onBeforeClear = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('hook');
    });
    const layer = clearToolOutputsMiddleware({ trigger: 0, keep: 1, onBeforeClear });
    const update = await layer.beforeModel?.(
      { messages: conversation(ids(2)), model: 'mock/m' },
      context
    );
    order.push('cleared');

    expect(order).toEqual(['hook', 'cleared']);
    expect(update).toBeDefined();
    const [event, hookContext] = onBeforeClear.mock.calls[0] as unknown as [
      {
        calls: { toolCallId: string; toolName: string; output: string; arguments: object }[];
        tokens: number;
        tokensFreed: number;
        model: string;
      },
      RunMiddlewareContext,
    ];
    expect(event.calls).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        toolName: 'fetch',
        output: BIG,
        arguments: { url: 'https://example.com/c1', notes: BIG },
      }),
    ]);
    expect(event.model).toBe('mock/m');
    expect(event.tokensFreed).toBeGreaterThan(900);
    expect(event.tokens).toBeGreaterThan(event.tokensFreed);
    expect(hookContext).toBe(context);
  });

  it('fails the turn and clears nothing when onBeforeClear throws', async () => {
    const layer = clearToolOutputsMiddleware({
      trigger: 0,
      keep: 1,
      onBeforeClear: () => {
        throw new Error('store down');
      },
    });
    await expect(
      layer.beforeModel?.({ messages: conversation(ids(2)), model: 'mock/m' }, contextWith())
    ).rejects.toThrow('store down');
  });

  it('refuses invalid options', () => {
    expect(() => clearToolOutputsMiddleware({ keep: -1 })).toThrow(CogitatorError);
    expect(() => clearToolOutputsMiddleware({ trigger: 1.5 })).toThrow(/trigger/);
  });

  it('answers recall_tool_output from the outputs the run cleared', async () => {
    const state = new Map<string, unknown>();
    const layer = clearToolOutputsMiddleware({ trigger: 0, keep: 1 });
    await layer.beforeModel?.(
      { messages: conversation(ids(2)), model: 'mock/m' },
      contextWith(state)
    );
    const recall = recallToolOutputTool();
    const next = vi.fn(async (): Promise<ToolResult> => ({
      callId: 'r1',
      name: RECALL_TOOL_OUTPUT,
      result: null,
    }));
    const toolCall = { id: 'r1', name: RECALL_TOOL_OUTPUT, arguments: { toolCallId: 'c1' } };

    const result = await layer.wrapToolCall?.(
      { toolCall, tool: recall, args: { toolCallId: 'c1' }, approved: false },
      next,
      contextWith(state)
    );

    expect(next).not.toHaveBeenCalled();
    expect(result?.result).toEqual({
      type: 'tool-content',
      content: [{ type: 'text', text: BIG }],
    });

    await layer.wrapToolCall?.(
      { toolCall, tool: recall, args: { toolCallId: 'c9' }, approved: false },
      next,
      contextWith(state)
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves other tools named recall_tool_output to themselves', async () => {
    const state = new Map<string, unknown>();
    const layer = clearToolOutputsMiddleware({ trigger: 0, keep: 1 });
    await layer.beforeModel?.(
      { messages: conversation(ids(2)), model: 'mock/m' },
      contextWith(state)
    );
    const own = tool({
      name: RECALL_TOOL_OUTPUT,
      description: 'Mine',
      parameters: z.object({ toolCallId: z.string() }),
      execute: async () => 'mine',
    });
    const next = vi.fn(async (): Promise<ToolResult> => ({
      callId: 'r1',
      name: RECALL_TOOL_OUTPUT,
      result: 'mine',
    }));
    await layer.wrapToolCall?.(
      {
        toolCall: { id: 'r1', name: RECALL_TOOL_OUTPUT, arguments: { toolCallId: 'c1' } },
        tool: own,
        args: { toolCallId: 'c1' },
        approved: false,
      },
      next,
      contextWith(state)
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('recallToolOutputTool', () => {
  it('says so when there is no memory to read', async () => {
    const recall = recallToolOutputTool();
    await expect(
      recall.execute({ toolCallId: 'c1' }, createToolContext({ threadId: 't1' }))
    ).rejects.toThrow(/no memory/);
  });
});

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function answer(content: string): ChatResponse {
  return { id: 'r', content, finishReason: 'stop', usage };
}

function callTool(name: string, args: Record<string, unknown>, id: string): ChatResponse {
  return {
    id: 'r',
    content: '',
    toolCalls: [{ id, name, arguments: args }],
    finishReason: 'tool_calls',
    usage,
  };
}

function scripted(...responses: ChatResponse[]) {
  const requests: ChatRequest[] = [];
  let index = 0;
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      requests.push({ ...request, messages: [...request.messages] });
      return responses[Math.min(index++, responses.length - 1)] ?? answer('done');
    }),
    chatStream: vi.fn(),
  };
  return { backend, requests };
}

const fetchPage = tool({
  name: 'fetch',
  description: 'Fetch a page',
  parameters: z.object({ page: z.number() }),
  execute: async ({ page }) => `page ${page}: ${BIG}`,
});

const originalOutput = (page: number) => JSON.stringify(`page ${page}: ${BIG}`);

function researcher(middleware: RunMiddleware[] = []) {
  return new Agent({
    name: 'researcher',
    model: 'mock/m',
    instructions: 'Help.',
    tools: [fetchPage],
    middleware,
  });
}

function toolMessage(request: ChatRequest | undefined, id: string): Message | undefined {
  return request?.messages.find((m) => m.role === 'tool' && m.toolCallId === id);
}

describe('context.clearToolOutputs in a run', () => {
  let cog: Cogitator | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await cog?.close();
    cog = undefined;
  });

  function runtime(backend: LLMBackend, context?: CogitatorConfig['context'], memory = false) {
    cog = new Cogitator({
      llm: { backends: { mock: backend } },
      ...(context && { context }),
      ...(memory && { memory: { adapter: 'memory' } }),
    });
    return cog;
  }

  it('is off by default: no recall tool and every output as it was', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      callTool('fetch', { page: 2 }, 'c2'),
      answer('Done')
    );
    const result = await runtime(backend).run(researcher(), { input: 'Go' });

    expect(requests.every((r) => !r.tools?.some((t) => t.name === RECALL_TOOL_OUTPUT))).toBe(true);
    expect(toolMessage(requests[2], 'c1')?.content).toBe(originalOutput(1));
    const root = result.trace.spans.find((span) => span.name === 'agent.run');
    expect(root?.attributes['context.cleared_tool_outputs']).toBeUndefined();
  });

  it('clears old outputs over later turns, keeps pairs valid and reports it on the run span', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      callTool('fetch', { page: 2 }, 'c2'),
      callTool('fetch', { page: 3 }, 'c3'),
      answer('Done')
    );
    const result = await runtime(backend, {
      enabled: false,
      clearToolOutputs: { trigger: 100, keep: 1 },
    }).run(researcher(), { input: 'Go' });

    expect(requests[0]?.tools?.map((t) => t.name)).toContain(RECALL_TOOL_OUTPUT);
    expect(toolMessage(requests[1], 'c1')?.content).toBe(originalOutput(1));
    expect(toolMessage(requests[2], 'c1')?.content).toBe(clearedOutputNote('c1'));
    expect(toolMessage(requests[2], 'c2')?.content).toBe(originalOutput(2));
    expect(clearedIds(requests[3]?.messages ?? [])).toEqual(['c1', 'c2']);
    for (const request of requests) expectValidPairs(request.messages);

    const root = result.trace.spans.find((span) => span.name === 'agent.run');
    expect(root?.attributes['context.cleared_tool_outputs']).toBe(2);
    expect(root?.attributes['context.clearings']).toBe(2);
    expect(root?.attributes['context.cleared_tool_output_tokens']).toBeGreaterThan(1_800);
    expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(3);
  });

  it('gives a cleared output back from the run when the model recalls it', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      callTool('fetch', { page: 2 }, 'c2'),
      callTool(RECALL_TOOL_OUTPUT, { toolCallId: 'c1' }, 'r1'),
      answer('Done')
    );
    await runtime(backend, { enabled: false, clearToolOutputs: { trigger: 100, keep: 1 } }).run(
      researcher(),
      { input: 'Go' }
    );

    expect(toolMessage(requests[2], 'c1')?.content).toBe(clearedOutputNote('c1'));
    expect(toolMessage(requests[3], 'r1')?.content).toBe(originalOutput(1));
  });

  it('runs before compaction, which sees the cleared conversation', async () => {
    const seen: Message[][] = [];
    vi.spyOn(ContextManager.prototype, 'shouldCompress').mockImplementation((messages) => {
      seen.push(messages);
      return false;
    });
    const { backend } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      callTool('fetch', { page: 2 }, 'c2'),
      answer('Done')
    );
    await runtime(backend, { clearToolOutputs: { trigger: 100, keep: 1 } }).run(researcher(), {
      input: 'Go',
    });

    expect(clearedIds(seen[2] ?? [])).toEqual(['c1']);
  });

  it('takes the defaults with clearToolOutputs: true', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      callTool('fetch', { page: 2 }, 'c2'),
      answer('Done')
    );
    await runtime(backend, { enabled: false, clearToolOutputs: true }).run(researcher(), {
      input: 'Go',
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toContain(RECALL_TOOL_OUTPUT);
    expect(clearedIds(requests[2]?.messages ?? [])).toEqual([]);
  });

  it('recalls an output from memory in a later run of the same thread, never another thread', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      answer('Fetched'),
      callTool(RECALL_TOOL_OUTPUT, { toolCallId: 'c1' }, 'r1'),
      answer('Recalled'),
      callTool(RECALL_TOOL_OUTPUT, { toolCallId: 'c1' }, 'r2'),
      answer('Nothing')
    );
    const runner = runtime(backend, { enabled: false, clearToolOutputs: {} }, true);
    const agent = researcher();
    await runner.run(agent, { input: 'Fetch page 1', threadId: 'thread_a' });
    await runner.run(agent, { input: 'What did page 1 say?', threadId: 'thread_a' });
    await runner.run(agent, { input: 'What did page 1 say?', threadId: 'thread_b' });

    expect(toolMessage(requests[3], 'r1')?.content).toBe(originalOutput(1));
    const refused = String(toolMessage(requests[5], 'r2')?.content);
    expect(refused).toContain('No output of tool call c1');
    expect(refused).not.toContain(BIG);
  });

  it('reads no memory for a run that does not use it, whatever thread it names', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      answer('Fetched'),
      callTool(RECALL_TOOL_OUTPUT, { toolCallId: 'c1' }, 'r1'),
      answer('Nothing')
    );
    const runner = runtime(backend, { enabled: false, clearToolOutputs: {} }, true);
    const agent = researcher();
    await runner.run(agent, { input: 'Fetch page 1', threadId: 'thread_a', userId: 'alice' });
    await runner.run(agent, {
      input: 'What did page 1 say?',
      threadId: 'thread_a',
      userId: 'bob',
      useMemory: false,
    });

    const refused = String(toolMessage(requests[3], 'r1')?.content);
    expect(refused).toContain('keeps no memory');
    expect(refused).not.toContain(BIG);
  });

  it('recalls the output of the branch the run is on, not of another branch', async () => {
    const { backend, requests } = scripted(
      callTool('fetch', { page: 1 }, 'c1'),
      answer('Fetched'),
      callTool('fetch', { page: 2 }, 'c1'),
      answer('Fetched again'),
      callTool(RECALL_TOOL_OUTPUT, { toolCallId: 'c1' }, 'r1'),
      answer('Recalled')
    );
    const runner = runtime(backend, { enabled: false, clearToolOutputs: {} }, true);
    const agent = researcher();
    const first = await runner.run(agent, { input: 'Fetch page 1', threadId: 'thread_a' });
    await runner.run(agent, {
      input: 'Fetch page 2 instead',
      threadId: 'thread_a',
      branch: { fromEntryId: first.memory!.branchPoint, activate: false },
    });
    await runner.run(agent, { input: 'What did it say?', threadId: 'thread_a' });

    expect(toolMessage(requests[5], 'r1')?.content).toBe(originalOutput(1));
  });
});
