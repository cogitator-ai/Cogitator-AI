import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from './helpers/fake-react.js';
import type { AgentResponse } from '../types.js';

vi.mock('react', async () => (await import('./helpers/fake-react.js')).reactApi);

const { useCogitatorAgent } = await import('../client/use-agent.js');

function agentResponse(output: string): AgentResponse {
  return {
    output,
    threadId: 'thread_1',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    toolCalls: [],
  };
}

interface Pending {
  signal: AbortSignal;
  resolve: (response: Response) => void;
}

function installDeferredFetch() {
  const pending: Pending[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          pending.push({ signal, resolve });
        })
    )
  );
  return pending;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('useCogitatorAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the result and calls onSuccess', async () => {
    const pending = installDeferredFetch();
    const onSuccess = vi.fn();
    const hook = renderHook(() => useCogitatorAgent({ api: '/api/agent', onSuccess }));

    const run = hook.result.current.run({ input: 'hi' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve(json(agentResponse('hello')));
    await run;
    await hook.flush();

    expect(hook.result.current.result?.output).toBe('hello');
    expect(hook.result.current.isLoading).toBe(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('ignores the result of a superseded run', async () => {
    const pending = installDeferredFetch();
    const onSuccess = vi.fn();
    const hook = renderHook(() => useCogitatorAgent({ api: '/api/agent', onSuccess }));

    const first = hook.result.current.run({ input: 'first' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = hook.result.current.run({ input: 'second' });
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[0].signal.aborted).toBe(true);
    await first;
    await hook.flush();
    expect(hook.result.current.isLoading).toBe(true);
    expect(hook.result.current.error).toBeNull();

    pending[1].resolve(json(agentResponse('second result')));
    await second;
    await hook.flush();

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(hook.result.current.result?.output).toBe('second result');
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('reset cancels the in-flight run', async () => {
    const pending = installDeferredFetch();
    const onError = vi.fn();
    const hook = renderHook(() => useCogitatorAgent({ api: '/api/agent', onError }));

    const run = hook.result.current.run({ input: 'hi' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    hook.result.current.reset();
    await run;
    await hook.flush();

    expect(pending[0].signal.aborted).toBe(true);
    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('exposes HTTP errors with status', async () => {
    const pending = installDeferredFetch();
    const onError = vi.fn();
    const hook = renderHook(() => useCogitatorAgent({ api: '/api/agent', onError }));

    const run = hook.result.current.run({ input: 'hi' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve(json({ error: 'input must be a non-empty string' }, 400));
    await run;
    await hook.flush();

    expect(hook.result.current.error?.message).toBe(
      'Request failed: 400 - input must be a non-empty string'
    );
    expect(hook.result.current.error).toMatchObject({ status: 400 });
    expect(onError).toHaveBeenCalledOnce();
  });
});
