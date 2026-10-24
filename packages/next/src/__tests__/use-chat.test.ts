import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from './helpers/fake-react.js';
import type { PendingApproval, PendingInterrupt, StreamEvent } from '../streaming/protocol.js';
import type { ChatMessage, UseChatOptions } from '../types.js';

vi.mock('react', async () => (await import('./helpers/fake-react.js')).reactApi);

const { useCogitatorChat } = await import('../client/use-chat.js');

interface ControlledStream {
  push: (event: StreamEvent | '[DONE]') => void;
  close: () => void;
}

interface FetchCall {
  body: {
    messages: ChatMessage[];
    threadId?: string;
    metadata?: Record<string, unknown>;
    multitaskStrategy?: string;
  };
  signal: AbortSignal;
  stream: ControlledStream;
}

const encoder = new TextEncoder();

function installFetch(respond?: (call: FetchCall) => Response | undefined) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    signal.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('aborted', 'AbortError'));
      } catch {}
    });
    const call: FetchCall = {
      body: JSON.parse(String(init.body)),
      signal,
      stream: {
        push: (event) =>
          controller.enqueue(
            encoder.encode(`data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`)
          ),
        close: () => controller.close(),
      },
    };
    calls.push(call);
    const custom = respond?.(call);
    if (custom) return custom;
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function completeStream(stream: ControlledStream, id: string, text: string, threadId?: string) {
  stream.push({ type: 'start', messageId: id });
  stream.push({ type: 'text-start', id: `${id}_t` });
  for (const ch of text) stream.push({ type: 'text-delta', id: `${id}_t`, delta: ch });
  stream.push({ type: 'text-end', id: `${id}_t` });
  stream.push({ type: 'finish', messageId: id, threadId });
  stream.push('[DONE]');
  stream.close();
}

function setup(options: Partial<UseChatOptions> = {}) {
  return renderHook(() => useCogitatorChat({ api: '/api/chat', ...options }));
}

describe('useCogitatorChat', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the complete assistant message to onFinish', async () => {
    const { calls } = installFetch((call) => {
      completeStream(call.stream, 'a1', 'Hello there');
      return undefined;
    });
    const onFinish = vi.fn();
    const hook = setup({ onFinish });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(calls).toHaveLength(1);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1', role: 'assistant', content: 'Hello there' })
    );
    expect(hook.result.current.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello there'],
    ]);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('accumulates reasoning deltas on the assistant message', async () => {
    installFetch((call) => {
      call.stream.push({ type: 'start', messageId: 'a1' });
      call.stream.push({ type: 'reasoning-start', id: 'r1' });
      call.stream.push({ type: 'reasoning-delta', id: 'r1', delta: 'Let me ' });
      call.stream.push({ type: 'reasoning-delta', id: 'r1', delta: 'think' });
      call.stream.push({ type: 'reasoning-end', id: 'r1' });
      call.stream.push({ type: 'text-start', id: 't1' });
      call.stream.push({ type: 'text-delta', id: 't1', delta: 'Answer' });
      call.stream.push({ type: 'text-end', id: 't1' });
      call.stream.push({ type: 'finish', messageId: 'a1' });
      call.stream.push('[DONE]');
      call.stream.close();
      return undefined;
    });
    const onReasoning = vi.fn();
    const onFinish = vi.fn();
    const hook = setup({ onReasoning, onFinish });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(onReasoning.mock.calls.map(([delta]) => delta)).toEqual(['Let me ', 'think']);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Answer', reasoning: 'Let me think' })
    );
    expect(hook.result.current.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Answer',
      reasoning: 'Let me think',
    });
  });

  it('shows the reasoning of a message that is still streaming', async () => {
    const { calls } = installFetch();
    const hook = setup();

    const pending = hook.result.current.send('Hi');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].stream.push({ type: 'start', messageId: 'a1' });
    calls[0].stream.push({ type: 'reasoning-delta', id: 'r1', delta: 'Pondering' });
    await vi.waitFor(() =>
      expect(hook.result.current.messages.at(-1)).toMatchObject({ reasoning: 'Pondering' })
    );

    hook.result.current.stop();
    await pending;
  });

  it('adopts the thread id announced by the server and sends it on the next turn', async () => {
    const { calls } = installFetch((call) => {
      completeStream(call.stream, `a${calls.length}`, 'ok', 'thread_srv');
      return undefined;
    });
    const hook = setup();

    await hook.result.current.send('first');
    await hook.flush();
    expect(hook.result.current.threadId).toBe('thread_srv');

    await hook.result.current.send('second');
    expect(calls[1].body.threadId).toBe('thread_srv');
    expect(calls[1].body.messages.map((m) => m.content)).toEqual(['first', 'ok', 'second']);
  });

  it('starts a new conversation when the thread id is cleared', async () => {
    const { calls } = installFetch((call) => {
      completeStream(call.stream, `a${calls.length}`, 'ok', 'thread_srv');
      return undefined;
    });
    const hook = setup();

    await hook.result.current.send('first');
    await hook.flush();
    hook.result.current.clearMessages();
    hook.result.current.setThreadId(undefined);
    await hook.flush();
    expect(hook.result.current.threadId).toBeUndefined();

    await hook.result.current.send('fresh');
    expect(calls[1].body.threadId).toBeUndefined();
    expect(calls[1].body.messages.map((m) => m.content)).toEqual(['fresh']);
  });

  it('keeps the partial assistant message when stopped', async () => {
    const { calls } = installFetch();
    const hook = setup();

    const pending = hook.result.current.send('Tell me a story');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].stream.push({ type: 'start', messageId: 'a1' });
    calls[0].stream.push({ type: 'text-delta', id: 't', delta: 'Once upon' });
    await hook.flush();

    hook.result.current.stop();
    await pending;
    await hook.flush();

    expect(calls[0].signal.aborted).toBe(true);
    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Tell me a story'],
      ['assistant', 'Once upon'],
    ]);
  });

  it('does not let a superseded request clear the loading state of the new one', async () => {
    const { calls } = installFetch();
    const hook = setup();

    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].stream.push({ type: 'start', messageId: 'a1' });
    calls[0].stream.push({ type: 'text-delta', id: 't', delta: 'par' });
    await hook.flush();

    const second = hook.result.current.send('two');
    await first;
    await hook.flush();

    expect(calls).toHaveLength(2);
    expect(hook.result.current.isLoading).toBe(true);
    expect(calls[1].body.messages.map((m) => m.content)).toEqual(['one', 'par', 'two']);

    completeStream(calls[1].stream, 'a2', 'done');
    await second;
    await hook.flush();

    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.messages.map((m) => m.content)).toEqual([
      'one',
      'par',
      'two',
      'done',
    ]);
  });

  it('surfaces HTTP errors with status and server message', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: 'No user message provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const onError = vi.fn();
    const hook = setup({ onError });

    await hook.result.current.send('Hi');
    await hook.flush();

    const error = hook.result.current.error;
    expect(error?.message).toBe('Request failed: 400 - No user message provided');
    expect(error).toMatchObject({ status: 400 });
    expect(onError).toHaveBeenCalledWith(error);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('calls onError but not onFinish when the stream reports an error', async () => {
    installFetch((call) => {
      call.stream.push({ type: 'start', messageId: 'a1' });
      call.stream.push({ type: 'error', message: 'LLM crashed' });
      call.stream.close();
      return undefined;
    });
    const onError = vi.fn();
    const onFinish = vi.fn();
    const hook = setup({ onError, onFinish });

    await hook.result.current.send('Hi');
    await hook.flush();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'LLM crashed' }));
    expect(onFinish).not.toHaveBeenCalled();
    expect(hook.result.current.error?.message).toBe('LLM crashed');
  });

  it('keeps the last user message visible while reloading', async () => {
    const { calls } = installFetch();
    const hook = setup({
      initialMessages: [
        { id: 'u1', role: 'user', content: 'question' },
        { id: 'a0', role: 'assistant', content: 'bad answer' },
      ],
    });

    const reloading = hook.result.current.reload();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await hook.flush();

    expect(hook.result.current.messages.map((m) => m.content)).toEqual(['question']);
    expect(calls[0].body.messages.map((m) => m.content)).toEqual(['question']);

    completeStream(calls[0].stream, 'a1', 'good answer');
    await reloading;
    await hook.flush();
    expect(hook.result.current.messages.map((m) => m.content)).toEqual(['question', 'good answer']);
  });

  it('collects tool calls into the assistant message', async () => {
    installFetch((call) => {
      call.stream.push({ type: 'start', messageId: 'a1' });
      call.stream.push({ type: 'tool-call-start', id: 'tc1', toolName: 'search' });
      call.stream.push({ type: 'tool-call-delta', id: 'tc1', argsTextDelta: '{"q":' });
      call.stream.push({ type: 'tool-call-delta', id: 'tc1', argsTextDelta: '"x"}' });
      call.stream.push({ type: 'tool-call-end', id: 'tc1' });
      call.stream.push({ type: 'tool-result', id: 'tr1', toolCallId: 'tc1', result: 42 });
      call.stream.push({ type: 'finish', messageId: 'a1' });
      call.stream.close();
      return undefined;
    });
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const onFinish = vi.fn();
    const hook = setup({ onToolCall, onToolResult, onFinish });

    await hook.result.current.send('find x');

    const toolCall = { id: 'tc1', name: 'search', arguments: { q: 'x' } };
    expect(onToolCall).toHaveBeenCalledWith(toolCall);
    expect(onToolResult).toHaveBeenCalledWith({ id: 'tr1', toolCallId: 'tc1', result: 42 });
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: [toolCall] }));
  });

  it('aborts the in-flight request on unmount', async () => {
    const { calls } = installFetch();
    const hook = setup();

    const pending = hook.result.current.send('Hi');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    hook.unmount();
    await pending;

    expect(calls[0].signal.aborted).toBe(true);
  });
});

describe('useCogitatorChat multitask strategies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function contents(hook: ReturnType<typeof setup>) {
    return hook.result.current.messages.map((m) => [m.role, m.content]);
  }

  async function startStreaming(hook: ReturnType<typeof setup>, calls: FetchCall[]) {
    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].stream.push({ type: 'start', messageId: 'a1', threadId: 'thread_1' });
    calls[0].stream.push({ type: 'text-delta', id: 't1', delta: 'Hel' });
    await hook.flush();
    return { first };
  }

  function finishStream(stream: ControlledStream, id: string, text: string) {
    stream.push({ type: 'text-delta', id: `${id}_t`, delta: text });
    stream.push({ type: 'finish', messageId: id, threadId: 'thread_1' });
    stream.push('[DONE]');
    stream.close();
  }

  it('lets an enqueued message through and shows its answer after the running one', async () => {
    const { calls } = installFetch();
    const onFinish = vi.fn();
    const hook = setup({ multitaskStrategy: 'enqueue', onFinish });
    const { first } = await startStreaming(hook, calls);

    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].stream.push({ type: 'start', messageId: 'a2', threadId: 'thread_1' });
    await hook.flush();

    expect(calls[0].signal.aborted).toBe(false);
    expect(calls[1].body).toMatchObject({ threadId: 'thread_1', multitaskStrategy: 'enqueue' });
    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hel'],
    ]);

    finishStream(calls[0].stream, 'a1', 'lo');
    await first;
    await hook.flush();
    expect(hook.result.current.isLoading).toBe(true);

    finishStream(calls[1].stream, 'a2', 'Second');
    await second;
    await hook.flush();

    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hello'],
      ['assistant', 'Second'],
    ]);
    expect(onFinish.mock.calls.map(([message]) => message.content)).toEqual(['Hello', 'Second']);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('keeps the answer of an enqueued message that arrives before the running one ends', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });
    const { first } = await startStreaming(hook, calls);

    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].stream.push({ type: 'start', messageId: 'a2', threadId: 'thread_1' });
    finishStream(calls[1].stream, 'a2', 'Second');
    await second;
    await hook.flush();

    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hel'],
    ]);
    expect(hook.result.current.isLoading).toBe(true);

    finishStream(calls[0].stream, 'a1', 'lo');
    await first;
    await hook.flush();

    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hello'],
      ['assistant', 'Second'],
    ]);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('reports a message the server rejects without touching the running answer', async () => {
    const { calls } = installFetch();
    const onError = vi.fn();
    const onFinish = vi.fn();
    const hook = setup({ multitaskStrategy: 'reject', onError, onFinish });
    const { first } = await startStreaming(hook, calls);

    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].stream.push({ type: 'start', messageId: 'a2', threadId: 'thread_1' });
    calls[1].stream.push({ type: 'error', message: 'Thread is busy', code: 'THREAD_BUSY' });
    calls[1].stream.close();
    await second;
    await hook.flush();

    expect(calls[0].signal.aborted).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Thread is busy' }));
    expect(hook.result.current.error?.message).toBe('Thread is busy');
    expect(hook.result.current.isLoading).toBe(true);

    finishStream(calls[0].stream, 'a1', 'lo');
    await first;
    await hook.flush();

    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hello'],
    ]);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hello' }));
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('reports a 409 answer to a rejected message and keeps streaming the running one', async () => {
    const { calls } = installFetch((call) =>
      call.body.messages.length > 1
        ? new Response(
            JSON.stringify({ error: { message: 'Thread is busy', code: 'THREAD_BUSY' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          )
        : undefined
    );
    const hook = setup({ multitaskStrategy: 'reject' });
    const { first } = await startStreaming(hook, calls);

    await hook.result.current.send('two');
    await hook.flush();

    expect(hook.result.current.error).toMatchObject({ status: 409 });
    expect(hook.result.current.isLoading).toBe(true);

    finishStream(calls[0].stream, 'a1', 'lo');
    await first;
    await hook.flush();

    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hello'],
    ]);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('stops every open request on stop', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });
    const { first } = await startStreaming(hook, calls);

    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    hook.result.current.stop();
    await Promise.all([first, second]);
    await hook.flush();

    expect(calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    expect(hook.result.current.isLoading).toBe(false);
    expect(contents(hook)).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Hel'],
    ]);
  });

  it.each(['interrupt', 'rollback'] as const)(
    'hands the running request over to the server when the strategy is %s',
    async (multitaskStrategy) => {
      const { calls } = installFetch();
      const onError = vi.fn();
      const onFinish = vi.fn();
      const hook = setup({ multitaskStrategy, onError, onFinish });
      const { first } = await startStreaming(hook, calls);

      const second = hook.result.current.send('two');
      await vi.waitFor(() => expect(calls).toHaveLength(2));

      expect(calls[0].signal.aborted).toBe(false);
      expect(calls[1].body).toMatchObject({ threadId: 'thread_1', multitaskStrategy });

      calls[0].stream.push({ type: 'text-delta', id: 't1', delta: 'late' });
      calls[0].stream.push({ type: 'error', message: 'Run interrupted', code: 'RUN_INTERRUPTED' });
      calls[0].stream.close();
      await first;
      await hook.flush();

      expect(contents(hook)).toEqual([
        ['user', 'one'],
        ['assistant', 'Hel'],
        ['user', 'two'],
      ]);
      expect(hook.result.current.error).toBeNull();
      expect(hook.result.current.isLoading).toBe(true);

      completeStream(calls[1].stream, 'a2', 'Second', 'thread_1');
      await second;
      await hook.flush();

      expect(contents(hook)).toEqual([
        ['user', 'one'],
        ['assistant', 'Hel'],
        ['user', 'two'],
        ['assistant', 'Second'],
      ]);
      expect(onError).not.toHaveBeenCalled();
      expect(onFinish.mock.calls.map(([message]) => message.content)).toEqual(['Second']);
      expect(hook.result.current.isLoading).toBe(false);
    }
  );

  it('aborts a handed-over request the server left open once the new one is done', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'rollback' });
    const { first } = await startStreaming(hook, calls);

    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    completeStream(calls[1].stream, 'a2', 'Second', 'thread_1');
    await second;

    expect(calls[0].signal.aborted).toBe(true);
    await first;
    await hook.flush();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('aborts the handed-over request when the new one fails before it runs', async () => {
    const { calls } = installFetch((call) =>
      call.body.messages.length > 1
        ? new Response(JSON.stringify({ error: { message: 'Forbidden' } }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
        : undefined
    );
    const hook = setup({ multitaskStrategy: 'interrupt' });
    const { first } = await startStreaming(hook, calls);

    await hook.result.current.send('two');
    await first;
    await hook.flush();

    expect(calls[0].signal.aborted).toBe(true);
    expect(hook.result.current.error).toMatchObject({ status: 403 });
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('stops a handed-over request on stop', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'rollback' });
    const { first } = await startStreaming(hook, calls);

    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    hook.result.current.stop();
    await Promise.all([first, second]);
    await hook.flush();

    expect(calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    expect(hook.result.current.isLoading).toBe(false);
  });
});

describe('useCogitatorChat multitask strategies on a new thread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends messages in a row to the thread the server picks for the first', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });

    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = hook.result.current.send('two');
    const third = hook.result.current.send('three');
    await hook.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].body.threadId).toBeUndefined();

    calls[0].stream.push({ type: 'start', messageId: 'a1', threadId: 'thread_new' });
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(calls.slice(1).map((call) => call.body.threadId)).toEqual(['thread_new', 'thread_new']);
    expect(calls.slice(1).map((call) => call.body.messages.at(-1)?.content)).toEqual([
      'two',
      'three',
    ]);

    completeStream(calls[0].stream, 'a1', 'A', 'thread_new');
    completeStream(calls[1].stream, 'a2', 'B', 'thread_new');
    completeStream(calls[2].stream, 'a3', 'C', 'thread_new');
    await Promise.all([first, second, third]);
    await hook.flush();
    expect(hook.result.current.threadId).toBe('thread_new');
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('rolls back on the thread of a first message that has not named it yet', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'rollback' });

    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = hook.result.current.send('two');
    const third = hook.result.current.send('three');
    await hook.flush();
    expect(calls).toHaveLength(1);

    calls[0].stream.push({ type: 'start', messageId: 'a1', threadId: 'thread_new' });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await second;

    expect(calls[0].signal.aborted).toBe(false);
    expect(calls[1].body).toMatchObject({ threadId: 'thread_new', multitaskStrategy: 'rollback' });
    expect(calls[1].body.messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);

    completeStream(calls[1].stream, 'a3', 'Third', 'thread_new');
    await third;
    await first;
    await hook.flush();

    expect(calls).toHaveLength(2);
    expect(hook.result.current.messages.map((m) => m.content)).toEqual([
      'one',
      'two',
      'three',
      'Third',
    ]);
    expect(hook.result.current.threadId).toBe('thread_new');
  });

  it('lets the next message start a thread when the first one ends without naming one', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });

    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = hook.result.current.send('two');

    calls[0].stream.close();
    await first;
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1].body.threadId).toBeUndefined();
    completeStream(calls[1].stream, 'a2', 'Second', 'thread_two');
    await second;
    await hook.flush();
    expect(hook.result.current.threadId).toBe('thread_two');
  });

  it('never sends a message that was stopped while it waited for the thread', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });

    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = hook.result.current.send('two');

    hook.result.current.stop();
    await Promise.all([first, second]);
    await hook.flush();

    expect(calls).toHaveLength(1);
    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.error).toBeNull();
  });

  it('starts a new thread after the thread id is cleared', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });

    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    completeStream(calls[0].stream, 'a1', 'A', 'thread_old');
    await first;
    hook.result.current.setThreadId(undefined);

    const second = hook.result.current.send('fresh');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body.threadId).toBeUndefined();
    completeStream(calls[1].stream, 'a2', 'B', 'thread_fresh');
    await second;
  });
});

describe('useCogitatorChat pauses across enqueued messages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const refundApproval: PendingApproval = {
    toolCallId: 'call_1',
    toolName: 'refund',
    arguments: { order: 'A-1' },
    description: 'Refund an order',
  };

  const orderQuestion: PendingInterrupt = {
    id: 'int_1',
    kind: 'input',
    reason: 'pick_order',
    message: 'Which order should be refunded?',
  };

  async function pauseFirstBehindSecond(pause: StreamEvent) {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'enqueue' });
    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].stream.push({ type: 'start', messageId: 'a1', threadId: 'thread_1' });
    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    calls[0].stream.push(pause);
    calls[0].stream.push({ type: 'finish', messageId: 'a1', threadId: 'thread_1' });
    calls[0].stream.push('[DONE]');
    calls[0].stream.close();
    await first;
    await hook.flush();
    return { calls, hook, second };
  }

  it('drops the pause of a message once the enqueued one after it finishes', async () => {
    const { calls, hook, second } = await pauseFirstBehindSecond({
      type: 'approval-required',
      threadId: 'thread_1',
      approvals: [refundApproval],
    });
    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);

    completeStream(calls[1].stream, 'a2', 'Second', 'thread_1');
    await second;
    await hook.flush();

    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInterrupts).toEqual([]);
  });

  it('shows the pause of the enqueued message in place of the earlier one', async () => {
    const { calls, hook, second } = await pauseFirstBehindSecond({
      type: 'interrupt-required',
      threadId: 'thread_1',
      interrupts: [orderQuestion],
    });
    expect(hook.result.current.pendingInterrupts).toEqual([orderQuestion]);

    calls[1].stream.push({ type: 'start', messageId: 'a2', threadId: 'thread_1' });
    calls[1].stream.push({
      type: 'approval-required',
      threadId: 'thread_1',
      approvals: [refundApproval],
    });
    calls[1].stream.push({ type: 'finish', messageId: 'a2', threadId: 'thread_1' });
    calls[1].stream.close();
    await second;
    await hook.flush();

    expect(hook.result.current.pendingInterrupts).toEqual([]);
    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);
  });

  it('keeps the pause of a message when the one after it is rejected', async () => {
    const { calls } = installFetch();
    const hook = setup({ multitaskStrategy: 'reject' });
    const first = hook.result.current.send('one');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].stream.push({ type: 'start', messageId: 'a1', threadId: 'thread_1' });
    const second = hook.result.current.send('two');
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    calls[1].stream.push({ type: 'start', messageId: 'a2', threadId: 'thread_1' });
    calls[1].stream.push({ type: 'error', message: 'Thread is busy', code: 'THREAD_BUSY' });
    calls[1].stream.close();
    await second;

    calls[0].stream.push({
      type: 'approval-required',
      threadId: 'thread_1',
      approvals: [refundApproval],
    });
    calls[0].stream.push({ type: 'finish', messageId: 'a1', threadId: 'thread_1' });
    calls[0].stream.close();
    await first;
    await hook.flush();

    expect(hook.result.current.pendingApprovals).toEqual([refundApproval]);
  });
});
