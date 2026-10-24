import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from './helpers/fake-react.js';
import type { PendingApproval, PendingInterrupt, StreamEvent } from '../streaming/protocol.js';
import type { AgentResponse, UseChatOptions } from '../types.js';

vi.mock('react', async () => (await import('./helpers/fake-react.js')).reactApi);

const { useCogitatorChat } = await import('../client/use-chat.js');

const refundApproval: PendingApproval = {
  toolCallId: 'call_1',
  toolName: 'refund',
  arguments: { order: 'A-1' },
  description: 'Refund an order',
};

interface Call {
  url: string;
  body: Record<string, unknown>;
}

type Reply = (call: Call) => Response;

function sse(events: Array<StreamEvent | '[DONE]'>): Response {
  const text = events
    .map((event) => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pausedStream(): Response {
  return sse([
    { type: 'start', messageId: 'a1' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Let me refund that.' },
    { type: 'text-end', id: 't1' },
    { type: 'approval-required', threadId: 'thread_srv', approvals: [refundApproval] },
    { type: 'finish', messageId: 'a1', threadId: 'thread_srv' },
    '[DONE]',
  ]);
}

function resumedStream(text: string): Response {
  return sse([
    { type: 'start', messageId: 'a2' },
    { type: 'tool-result', id: 'tr1', toolCallId: 'call_1', result: { refunded: 'A-1' } },
    { type: 'text-start', id: 't2' },
    { type: 'text-delta', id: 't2', delta: text },
    { type: 'text-end', id: 't2' },
    { type: 'finish', messageId: 'a2', threadId: 'thread_srv' },
    '[DONE]',
  ]);
}

function installFetch(replies: Reply[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      calls.push(call);
      const reply = replies[calls.length - 1];
      if (!reply) throw new Error(`Unexpected request ${calls.length} to ${url}`);
      return reply(call);
    })
  );
  return calls;
}

function setup(options: Partial<UseChatOptions> = {}) {
  return renderHook(() =>
    useCogitatorChat({ api: '/api/chat', resumeApi: '/api/chat/resume', ...options })
  );
}

async function pause(hook: ReturnType<typeof setup>) {
  await hook.result.current.send('Refund A-1');
  await hook.flush();
}

describe('useCogitatorChat approvals', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the approvals a paused stream waits on', async () => {
    installFetch([pausedStream]);
    const onApprovalRequired = vi.fn();
    const onFinish = vi.fn();
    const hook = setup({ onApprovalRequired, onFinish });

    expect(hook.result.current.pendingApprovals).toEqual([]);
    await pause(hook);

    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);
    expect(hook.result.current.threadId).toBe('thread_srv');
    expect(onApprovalRequired).toHaveBeenCalledWith([refundApproval]);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Let me refund that.' })
    );
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('approves every pending call and streams the rest of the run', async () => {
    const calls = installFetch([pausedStream, () => resumedStream('Refunded A-1')]);
    const onToolResult = vi.fn();
    const hook = setup({ onToolResult });
    await pause(hook);

    await hook.result.current.approve();
    await hook.flush();

    expect(calls[1]).toEqual({
      url: '/api/chat/resume',
      body: { threadId: 'thread_srv', defaultDecision: { approved: true } },
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call_1', result: { refunded: 'A-1' } })
    );
    expect(hook.result.current.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Refund A-1'],
      ['assistant', 'Let me refund that.'],
      ['assistant', 'Refunded A-1'],
    ]);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('denies every pending call with the reason', async () => {
    const calls = installFetch([pausedStream, () => resumedStream('Not refunded')]);
    const hook = setup();
    await pause(hook);

    await hook.result.current.deny('Over the limit');

    expect(calls[1]?.body).toEqual({
      threadId: 'thread_srv',
      defaultDecision: { approved: false, reason: 'Over the limit' },
    });
  });

  it('sends per-call decisions with resume', async () => {
    const calls = installFetch([pausedStream, () => resumedStream('Partly done')]);
    const hook = setup();
    await pause(hook);

    await hook.result.current.resume({ decisions: { call_1: { approved: true } } });

    expect(calls[1]?.body).toEqual({
      threadId: 'thread_srv',
      decisions: { call_1: { approved: true } },
    });
  });

  it('appends the answer of a JSON resume endpoint and keeps a new pause', async () => {
    const answer: AgentResponse = {
      output: 'Need another approval',
      threadId: 'thread_srv',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
      reasoning: 'Second refund',
      status: 'paused',
      pendingApprovals: [{ ...refundApproval, toolCallId: 'call_2' }],
      traceId: 'trace_1',
    };
    installFetch([pausedStream, () => json(answer)]);
    const onFinish = vi.fn();
    const onApprovalRequired = vi.fn();
    const hook = setup({ onFinish, onApprovalRequired });
    await pause(hook);

    await hook.result.current.approve();
    await hook.flush();

    expect(hook.result.current.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Need another approval',
      reasoning: 'Second refund',
    });
    expect(hook.result.current.pendingApprovals).toEqual([
      { ...refundApproval, toolCallId: 'call_2' },
    ]);
    expect(onApprovalRequired).toHaveBeenLastCalledWith([
      { ...refundApproval, toolCallId: 'call_2' },
    ]);
    expect(onFinish).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'Need another approval' })
    );
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('drops the approvals when the server has nothing paused anymore', async () => {
    installFetch([
      pausedStream,
      () => json({ error: 'Thread thread_srv has no paused run', code: 'RUN_NOT_PAUSED' }, 409),
    ]);
    const onError = vi.fn();
    const hook = setup({ onError });
    await pause(hook);

    await hook.result.current.approve();
    await hook.flush();

    expect(hook.result.current.error).toMatchObject({ status: 409 });
    expect(onError).toHaveBeenCalledOnce();
    expect(hook.result.current.pendingApprovals).toEqual([]);
  });

  it('keeps the approvals when a resume fails for another reason', async () => {
    installFetch([pausedStream, () => json({ error: 'Server down' }, 500)]);
    const hook = setup();
    await pause(hook);

    await hook.result.current.approve();
    await hook.flush();

    expect(hook.result.current.error).toMatchObject({ status: 500 });
    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);
  });

  it('clears the approvals when the user sends a new message instead', async () => {
    const calls = installFetch([
      pausedStream,
      () =>
        sse([
          { type: 'start', messageId: 'a2' },
          { type: 'finish', messageId: 'a2', threadId: 'thread_srv' },
        ]),
    ]);
    const hook = setup();
    await pause(hook);

    await hook.result.current.send('Never mind');
    await hook.flush();

    expect(calls[1]?.url).toBe('/api/chat');
    expect(hook.result.current.pendingApprovals).toEqual([]);
  });

  it('reports an error without a resume endpoint', async () => {
    const calls = installFetch([pausedStream]);
    const onError = vi.fn();
    const hook = setup({ resumeApi: undefined, onError });
    await pause(hook);

    await hook.result.current.approve();
    await hook.flush();

    expect(calls).toHaveLength(1);
    expect(hook.result.current.error?.message).toBe(
      'useCogitatorChat needs resumeApi to resume a paused run'
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);
  });

  it('reports an error when there is no thread to resume', async () => {
    const calls = installFetch([]);
    const hook = setup();

    await hook.result.current.approve();
    await hook.flush();

    expect(calls).toHaveLength(0);
    expect(hook.result.current.error?.message).toBe(
      'There is no thread with a paused run to resume'
    );
  });
});

const orderQuestion: PendingInterrupt = {
  id: 'int_1',
  kind: 'input',
  reason: 'pick_order',
  message: 'Which order should be refunded?',
  responseSchema: { type: 'string' },
};

function askingStream(): Response {
  return sse([
    { type: 'start', messageId: 'a1' },
    { type: 'interrupt-required', threadId: 'thread_srv', interrupts: [orderQuestion] },
    {
      type: 'finish',
      messageId: 'a1',
      threadId: 'thread_srv',
      status: 'paused',
      pendingApprovals: [],
      interrupts: [orderQuestion],
    },
    '[DONE]',
  ]);
}

describe('useCogitatorChat interrupts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the questions a paused stream waits on and answers them with resume', async () => {
    const calls = installFetch([askingStream, () => resumedStream('Refunded A-1')]);
    const onInterruptRequired = vi.fn();
    const onApprovalRequired = vi.fn();
    const hook = setup({ onInterruptRequired, onApprovalRequired });

    expect(hook.result.current.pendingInterrupts).toEqual([]);
    await pause(hook);

    expect(hook.result.current.pendingInterrupts).toEqual([orderQuestion]);
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.threadId).toBe('thread_srv');
    expect(onInterruptRequired).toHaveBeenCalledWith([orderQuestion]);
    expect(onApprovalRequired).not.toHaveBeenCalled();

    await hook.result.current.resume({ responses: { int_1: 'A-1' } });
    await hook.flush();

    expect(calls[1]).toEqual({
      url: '/api/chat/resume',
      body: { threadId: 'thread_srv', responses: { int_1: 'A-1' } },
    });
    expect(hook.result.current.pendingInterrupts).toEqual([]);
  });

  it('keeps the approvals a run that also asks questions waits on', async () => {
    installFetch([
      () =>
        sse([
          { type: 'start', messageId: 'a1' },
          {
            type: 'interrupt-required',
            threadId: 'thread_srv',
            interrupts: [orderQuestion, { ...orderQuestion, id: 'call_1', kind: 'approval' }],
          },
          {
            type: 'finish',
            messageId: 'a1',
            threadId: 'thread_srv',
            status: 'paused',
            pendingApprovals: [refundApproval],
            interrupts: [orderQuestion],
          },
        ]),
    ]);
    const hook = setup();
    await pause(hook);

    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);
    expect(hook.result.current.pendingInterrupts).toHaveLength(2);
  });

  it('exposes the questions of a JSON resume answer', async () => {
    const answer: AgentResponse = {
      output: 'Which order?',
      threadId: 'thread_srv',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
      status: 'paused',
      pendingApprovals: [],
      interrupts: [orderQuestion],
      traceId: 'trace_1',
    };
    installFetch([pausedStream, () => json(answer)]);
    const onApprovalRequired = vi.fn();
    const hook = setup({ onApprovalRequired });
    await pause(hook);

    await hook.result.current.approve();
    await hook.flush();

    expect(hook.result.current.pendingInterrupts).toEqual([orderQuestion]);
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(onApprovalRequired).toHaveBeenCalledOnce();
  });

  it('clears the questions when the user sends a new message instead', async () => {
    installFetch([
      askingStream,
      () =>
        sse([
          { type: 'start', messageId: 'a2' },
          { type: 'finish', messageId: 'a2', threadId: 'thread_srv' },
        ]),
    ]);
    const hook = setup();
    await pause(hook);

    await hook.result.current.send('Never mind');
    await hook.flush();

    expect(hook.result.current.pendingInterrupts).toEqual([]);
  });

  it('sends its multitask strategy with every message', async () => {
    const calls = installFetch([askingStream]);
    const hook = setup({ multitaskStrategy: 'enqueue' });
    await pause(hook);

    expect(calls[0]?.body).toMatchObject({ multitaskStrategy: 'enqueue' });
  });

  it('sends no multitask strategy unless it has one', async () => {
    const calls = installFetch([askingStream]);
    const hook = setup();
    await pause(hook);

    expect(calls[0]?.body).not.toHaveProperty('multitaskStrategy');
  });
});
