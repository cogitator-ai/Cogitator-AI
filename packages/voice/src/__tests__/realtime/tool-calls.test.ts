import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import type { ToolInvoker } from '@cogitator-ai/types';
import type { RealtimeTool, RealtimeToolContext } from '../../types.js';

type MockWebSocket = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  readyState: number;
};

let mockWs: MockWebSocket;

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class MockWS extends EE {
    static OPEN = 1;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    readyState = 1;

    constructor() {
      super();
      mockWs = this as unknown as MockWebSocket;
      setTimeout(() => this.emit('open'), 0);
    }
  }
  return { WebSocket: MockWS };
});

import { OpenAIRealtimeAdapter } from '../../realtime/openai-realtime.js';
import { GeminiRealtimeAdapter } from '../../realtime/gemini-realtime.js';
import { RealtimeSession } from '../../realtime/realtime-session.js';
import { createRealtimeTools } from '../../realtime/cogitator-tools.js';

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function sent(): Array<Record<string, unknown>> {
  return mockWs.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
}

function openAICalls(calls: Array<[name: string, callId: string, args: unknown]>): string {
  return JSON.stringify({
    type: 'response.done',
    response: {
      status: 'completed',
      output: calls.map(([name, call_id, args]) => ({
        type: 'function_call',
        name,
        call_id,
        arguments: JSON.stringify(args),
      })),
    },
  });
}

function functionOutputs(): Array<{ callId: string; output: unknown }> {
  return sent()
    .filter(
      (event) =>
        event.type === 'conversation.item.create' &&
        (event.item as { type: string }).type === 'function_call_output'
    )
    .map((event) => {
      const item = event.item as { call_id: string; output: string };
      return { callId: item.call_id, output: JSON.parse(item.output) };
    });
}

/** A tool that waits until its signal aborts, reporting the context it got. */
function hangingTool(name: string, contexts: RealtimeToolContext[]): RealtimeTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    execute: (_args, context) => {
      contexts.push(context);
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
}

async function connectOpenAI(tools: RealtimeTool[], sessionId?: string) {
  const adapter = new OpenAIRealtimeAdapter({
    provider: 'openai',
    apiKey: 'key',
    tools,
    ...(sessionId !== undefined && { sessionId }),
  });
  closers.push(() => adapter.close());
  await adapter.connect();
  mockWs.send.mockClear();
  return adapter;
}

async function connectGemini(tools: RealtimeTool[]) {
  const adapter = new GeminiRealtimeAdapter({ provider: 'gemini', apiKey: 'key', tools });
  closers.push(() => adapter.close());
  const connecting = adapter.connect();
  await vi.waitFor(() => expect(mockWs).toBeDefined());
  await new Promise((resolve) => setTimeout(resolve, 0));
  mockWs.emit('message', JSON.stringify({ setupComplete: {} }));
  await connecting;
  mockWs.send.mockClear();
  return adapter;
}

describe('realtime tool call context', () => {
  it('hands OpenAI tools the call id, a live signal and the session id', async () => {
    const contexts: RealtimeToolContext[] = [];
    await connectOpenAI([hangingTool('wait', contexts)], 'client-7');

    mockWs.emit('message', openAICalls([['wait', 'call_1', {}]]));
    await vi.waitFor(() => expect(contexts).toHaveLength(1));

    expect(contexts[0]).toMatchObject({ callId: 'call_1', sessionId: 'client-7' });
    expect(contexts[0]!.signal.aborted).toBe(false);
  });

  it('cancels running OpenAI tool calls when the session closes, without answering them', async () => {
    const contexts: RealtimeToolContext[] = [];
    const adapter = await connectOpenAI([hangingTool('wait', contexts)]);

    mockWs.emit('message', openAICalls([['wait', 'call_1', {}]]));
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    adapter.close();

    expect(contexts[0]!.signal.aborted).toBe(true);
    expect((contexts[0]!.signal.reason as Error).message).toBe('Realtime session closed');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('cancels running OpenAI tool calls when the connection drops', async () => {
    const contexts: RealtimeToolContext[] = [];
    await connectOpenAI([hangingTool('wait', contexts)]);

    mockWs.emit('message', openAICalls([['wait', 'call_1', {}]]));
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    mockWs.emit('close', 1006, Buffer.from('gone'));

    expect(contexts[0]!.signal.aborted).toBe(true);
  });

  it('aborts and leaves unanswered the Gemini calls Gemini cancels', async () => {
    const contexts: RealtimeToolContext[] = [];
    const quick: RealtimeTool = {
      name: 'quick',
      description: 'quick tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'done';
      },
    };
    await connectGemini([hangingTool('wait', contexts), quick]);

    mockWs.emit(
      'message',
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: 'g1', name: 'wait', args: {} },
            { id: 'g2', name: 'quick', args: {} },
          ],
        },
      })
    );
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]!.callId).toBe('g1');

    mockWs.emit('message', JSON.stringify({ toolCallCancellation: { ids: ['g1'] } }));
    expect(contexts[0]!.signal.aborted).toBe(true);

    await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(1));
    const [message] = sent();
    expect(message).toEqual({
      toolResponse: {
        functionResponses: [{ id: 'g2', name: 'quick', response: { result: 'done' } }],
      },
    });
  });

  it('leaves unanswered a Gemini call cancelled after it finished, while its batch still runs', async () => {
    const contexts: RealtimeToolContext[] = [];
    const quickDone = vi.fn();
    const quick: RealtimeTool = {
      name: 'quick',
      description: 'quick tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        quickDone();
        return 'done';
      },
    };
    await connectGemini([hangingTool('wait', contexts), quick]);

    mockWs.emit(
      'message',
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: 'g1', name: 'wait', args: {} },
            { id: 'g2', name: 'quick', args: {} },
          ],
        },
      })
    );
    await vi.waitFor(() => expect(quickDone).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockWs.emit('message', JSON.stringify({ toolCallCancellation: { ids: ['g1', 'g2'] } }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('sends no Gemini toolResponse when every call of it was cancelled', async () => {
    const contexts: RealtimeToolContext[] = [];
    await connectGemini([hangingTool('wait', contexts)]);

    mockWs.emit(
      'message',
      JSON.stringify({ toolCall: { functionCalls: [{ id: 'g1', name: 'wait', args: {} }] } })
    );
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    mockWs.emit('message', JSON.stringify({ toolCallCancellation: { ids: ['g1'] } }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('cancels running Gemini tool calls when the session closes', async () => {
    const contexts: RealtimeToolContext[] = [];
    const adapter = await connectGemini([hangingTool('wait', contexts)]);

    mockWs.emit(
      'message',
      JSON.stringify({ toolCall: { functionCalls: [{ id: 'g1', name: 'wait', args: {} }] } })
    );
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    adapter.close();

    expect(contexts[0]!.signal.aborted).toBe(true);
  });
});

describe('createRealtimeTools', () => {
  const deleteFile = vi.fn(async ({ path }: { path: string }) => `deleted ${path}`);
  const deleteTool = tool({
    name: 'delete_file',
    description: 'Delete a file',
    parameters: z.object({ path: z.string() }),
    requiresApproval: true,
    maxResultLength: 500,
    execute: deleteFile,
  });

  async function session(
    options: Parameters<typeof createRealtimeTools>[2] = {},
    cogitator = new Cogitator()
  ) {
    closers.push(() => cogitator.close());
    const realtime = new RealtimeSession({
      provider: 'openai',
      apiKey: 'key',
      sessionId: 'client-1',
      tools: createRealtimeTools(cogitator, [deleteTool], options),
    });
    closers.push(() => realtime.close());
    await realtime.connect();
    mockWs.send.mockClear();
    return realtime;
  }

  afterEach(() => deleteFile.mockClear());

  it('refuses a Gemini call that needs approval nobody gives, like an OpenAI one', async () => {
    const cogitator = new Cogitator();
    closers.push(() => cogitator.close());
    await connectGemini(createRealtimeTools(cogitator, [deleteTool]));

    mockWs.emit(
      'message',
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'g9', name: 'delete_file', args: { path: '/x' } }] },
      })
    );
    await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalledTimes(1));

    expect(deleteFile).not.toHaveBeenCalled();
    expect(sent()[0]).toEqual({
      toolResponse: {
        functionResponses: [
          {
            id: 'g9',
            name: 'delete_file',
            response: { error: 'Tool "delete_file" needs approval, and nobody approved this call' },
          },
        ],
      },
    });
  });

  it('does not run a Gemini call cancelled while its approval waits', async () => {
    const cogitator = new Cogitator();
    closers.push(() => cogitator.close());
    let approve: (() => void) | undefined;
    await connectGemini(
      createRealtimeTools(cogitator, [deleteTool], {
        onApproval: () =>
          new Promise((resolve) => {
            approve = () => resolve({ approved: true });
          }),
      })
    );

    mockWs.emit(
      'message',
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'g10', name: 'delete_file', args: { path: '/x' } }] },
      })
    );
    await vi.waitFor(() => expect(approve).toBeDefined());
    mockWs.emit('message', JSON.stringify({ toolCallCancellation: { ids: ['g10'] } }));
    approve!();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deleteFile).not.toHaveBeenCalled();
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('describes each tool with its JSON schema and result limit', () => {
    const [realtimeTool] = createRealtimeTools(new Cogitator(), [deleteTool]);
    expect(realtimeTool).toMatchObject({
      name: 'delete_file',
      description: 'Delete a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      maxResultLength: 500,
    });
  });

  it('refuses a call that needs approval when nobody can approve it', async () => {
    await session();

    mockWs.emit('message', openAICalls([['delete_file', 'call_1', { path: '/etc/hosts' }]]));
    await vi.waitFor(() => expect(functionOutputs()).toHaveLength(1));

    expect(deleteFile).not.toHaveBeenCalled();
    expect(functionOutputs()[0]).toEqual({
      callId: 'call_1',
      output: { error: 'Tool "delete_file" needs approval, and nobody approved this call' },
    });
  });

  it('asks onApproval with the call and runs it once approved', async () => {
    const onApproval = vi.fn(async () => ({ approved: true as const }));
    await session({ onApproval });

    mockWs.emit('message', openAICalls([['delete_file', 'call_2', { path: '/tmp/a' }]]));
    await vi.waitFor(() => expect(functionOutputs()).toHaveLength(1));

    expect(onApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call_2',
        toolName: 'delete_file',
        arguments: { path: '/tmp/a' },
        agentId: 'voice',
        threadId: 'voice:client-1',
      }),
      expect.objectContaining({ callId: 'call_2', sessionId: 'client-1' })
    );
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(functionOutputs()[0]).toEqual({ callId: 'call_2', output: 'deleted /tmp/a' });
  });

  it('passes the reason of a declined call to the model', async () => {
    await session({ onApproval: async () => ({ approved: false, reason: 'not today' }) });

    mockWs.emit('message', openAICalls([['delete_file', 'call_3', { path: '/tmp/a' }]]));
    await vi.waitFor(() => expect(functionOutputs()).toHaveLength(1));

    expect(deleteFile).not.toHaveBeenCalled();
    expect(functionOutputs()[0]!.output).toEqual({
      error: 'The user declined this tool call: not today',
    });
  });

  it('lets the guardrails decide when no onApproval is given', async () => {
    const onToolApproval = vi.fn(async (_toolName: string) => true);
    await session({}, new Cogitator({ guardrails: { enabled: true, onToolApproval } }));

    mockWs.emit('message', openAICalls([['delete_file', 'call_4', { path: '/tmp/b' }]]));
    await vi.waitFor(() => expect(functionOutputs()).toHaveLength(1));

    expect(onToolApproval).toHaveBeenCalledTimes(1);
    expect(onToolApproval.mock.calls[0]![0]).toBe('delete_file');
    expect(functionOutputs()[0]!.output).toBe('deleted /tmp/b');
  });

  it('validates the arguments against the tool schema before running it', async () => {
    await session({ onApproval: async () => ({ approved: true }) });

    mockWs.emit('message', openAICalls([['delete_file', 'call_5', { path: 42 }]]));
    await vi.waitFor(() => expect(functionOutputs()).toHaveLength(1));

    expect(deleteFile).not.toHaveBeenCalled();
    expect(JSON.stringify(functionOutputs()[0]!.output)).toContain('error');
  });

  it('keeps the tool timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Slow tool',
      parameters: z.object({}),
      timeout: 20,
      execute: () => new Promise<string>(() => {}),
    });
    const cogitator = new Cogitator();
    closers.push(() => cogitator.close());
    const realtime = new RealtimeSession({
      provider: 'openai',
      apiKey: 'key',
      tools: createRealtimeTools(cogitator, [slow]),
    });
    closers.push(() => realtime.close());
    await realtime.connect();
    mockWs.send.mockClear();

    mockWs.emit('message', openAICalls([['slow', 'call_6', {}]]));
    await vi.waitFor(() => expect(functionOutputs()).toHaveLength(1));

    expect(functionOutputs()[0]!.output).toEqual({
      error: 'Tool "slow" timed out after 20ms',
    });
  });

  it('hands the invoker the call id, signal, session thread and options', async () => {
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (t) => ({
      callId: 'call_7',
      name: t.name,
      result: 'ok',
    }));
    const onApproval = vi.fn(async () => ({ approved: true as const }));
    const [realtimeTool] = createRealtimeTools({ invokeTool }, [deleteTool], {
      agentId: 'phone',
      userId: 'u1',
      onApproval,
    });
    const signal = new AbortController().signal;
    const context = { callId: 'call_7', signal, sessionId: 's1' };

    await expect(realtimeTool!.execute({ path: '/x' }, context)).resolves.toBe('ok');

    const options = invokeTool.mock.calls[0]![2]!;
    expect(options).toEqual({
      toolCallId: 'call_7',
      agentId: 'phone',
      signal,
      threadId: 'voice:s1',
      userId: 'u1',
      onApproval: expect.any(Function),
    });
    const request = {
      toolCallId: 'call_7',
      toolName: 'delete_file',
      arguments: { path: '/x' },
      description: 'Delete a file',
    };
    await options.onApproval!(request);
    expect(onApproval).toHaveBeenCalledWith(request, context);
  });

  it('chooses the user per call and passes the agent for its gates', async () => {
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (t) => ({
      callId: 'c',
      name: t.name,
      result: null,
    }));
    const agent = { id: 'a1', name: 'concierge', model: 'mock/m', config: {} };
    const [realtimeTool] = createRealtimeTools({ invokeTool }, [deleteTool], {
      agent,
      userId: ({ sessionId }) => `user-of-${sessionId}`,
    });
    const signal = new AbortController().signal;

    await realtimeTool!.execute({ path: '/x' }, { callId: 'c', signal, sessionId: 's9' });

    expect(invokeTool.mock.calls[0]![2]).toEqual({
      toolCallId: 'c',
      agentId: 'a1',
      agent,
      signal,
      threadId: 'voice:s9',
      userId: 'user-of-s9',
    });
  });

  it('leaves the thread out without a session id, or uses the threadId option', async () => {
    const invokeTool = vi.fn<ToolInvoker['invokeTool']>(async (t) => ({
      callId: 'c',
      name: t.name,
      result: null,
    }));
    const signal = new AbortController().signal;

    const [plain] = createRealtimeTools({ invokeTool }, [deleteTool]);
    await plain!.execute({ path: '/x' }, { callId: 'c', signal });
    expect(invokeTool.mock.calls[0]![2]).toEqual({ toolCallId: 'c', agentId: 'voice', signal });

    const [threaded] = createRealtimeTools({ invokeTool }, [deleteTool], {
      threadId: (context) => `calls:${context.callId}`,
    });
    await threaded!.execute({ path: '/x' }, { callId: 'c', signal, sessionId: 's1' });
    expect(invokeTool.mock.calls[1]![2]).toMatchObject({ threadId: 'calls:c' });
  });
});
