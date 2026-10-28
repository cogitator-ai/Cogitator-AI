import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from './helpers/fake-react.js';
import type { StreamEvent } from '../streaming/protocol.js';

vi.mock('react', async () => (await import('./helpers/fake-react.js')).reactApi);

const { useCogitatorChat } = await import('../client/use-chat.js');

const encoder = new TextEncoder();

function streamOnce(events: StreamEvent[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    })
  );
}

describe('useCogitatorChat data parts, state and reset-step', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the latest data part of each id on the message, transient ones only reported', async () => {
    streamOnce([
      { type: 'start', messageId: 'a1' },
      { type: 'data', id: 'w', name: 'weather', data: { temp: 1 }, toolCallId: 'c1' },
      { type: 'data', id: 's', name: 'status', data: 'busy', transient: true },
      { type: 'data', id: 'w', name: 'weather', data: { temp: 2 }, toolCallId: 'c1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Warm' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', messageId: 'a1' },
    ]);
    const onData = vi.fn();
    const hook = renderHook(() => useCogitatorChat({ api: '/api/chat', onData }));

    await hook.result.current.send('Weather?');
    await hook.flush();

    const answer = hook.result.current.messages.at(-1);
    expect(answer?.data).toEqual([
      { id: 'w', name: 'weather', data: { temp: 2 }, toolCallId: 'c1' },
    ]);
    expect(onData.mock.calls.map(([part]) => part.id)).toEqual(['w', 's', 'w']);
  });

  it('follows the run state through snapshots and JSON Patches', async () => {
    streamOnce([
      { type: 'start', messageId: 'a1' },
      { type: 'state-snapshot', snapshot: { items: ['a'] } },
      { type: 'state-delta', delta: [{ op: 'add', path: '/items/1', value: 'b' }] },
      { type: 'finish', messageId: 'a1' },
    ]);
    const onStateChange = vi.fn();
    const hook = renderHook(() => useCogitatorChat({ api: '/api/chat', onStateChange }));

    await hook.result.current.send('Add b');
    await hook.flush();

    expect(hook.result.current.state).toEqual({ items: ['a', 'b'] });
    expect(onStateChange).toHaveBeenCalledTimes(2);

    hook.result.current.setThreadId('another-thread');
    await hook.flush();
    expect(hook.result.current.state).toBeUndefined();
  });

  it('takes back what a step streamed before it started over', async () => {
    streamOnce([
      { type: 'start', messageId: 'a1' },
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', delta: 'Kept. ' },
      { type: 'text-end', id: 't0' },
      { type: 'tool-call-start', id: 'c0', toolName: 'search' },
      { type: 'tool-call-delta', id: 'c0', argsTextDelta: '{}' },
      { type: 'tool-call-end', id: 'c0' },
      { type: 'tool-result', id: 'r0', toolCallId: 'c0', result: 'ok' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'hmm' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Half an' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-call-start', id: 'c1', toolName: 'search' },
      { type: 'tool-call-delta', id: 'c1', argsTextDelta: '{"q"' },
      { type: 'reset-step', partIds: ['r1', 't1'], toolCallIds: ['c1'] },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'Whole answer' },
      { type: 'text-end', id: 't2' },
      { type: 'finish', messageId: 'a1' },
    ]);
    const onToolCallDropped = vi.fn();
    const hook = renderHook(() => useCogitatorChat({ api: '/api/chat', onToolCallDropped }));

    await hook.result.current.send('Go');
    await hook.flush();

    const answer = hook.result.current.messages.at(-1);
    expect(answer?.content).toBe('Kept. Whole answer');
    expect(answer?.reasoning).toBeUndefined();
    expect(answer?.toolCalls?.map((call) => call.id)).toEqual(['c0']);
    expect(onToolCallDropped).toHaveBeenCalledWith('c1');
  });
});
