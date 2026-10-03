import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from './helpers/fake-react.js';
import type { StreamEvent } from '../streaming/protocol.js';
import type { ChatMessage, UseChatOptions } from '../types.js';

vi.mock('react', async () => (await import('./helpers/fake-react.js')).reactApi);

const { useCogitatorChat } = await import('../client/use-chat.js');

interface ControlledStream {
  push: (event: StreamEvent | '[DONE]') => void;
  close: () => void;
}

interface FetchCall {
  body: { messages: ChatMessage[]; threadId?: string; metadata?: Record<string, unknown> };
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
