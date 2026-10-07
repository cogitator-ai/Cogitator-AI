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
    status: 'completed',
    traceId: 'trace_1',
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

  it('exposes the reasoning of the result', async () => {
    const pending = installDeferredFetch();
    const hook = renderHook(() => useCogitatorAgent({ api: '/api/agent' }));
    expect(hook.result.current.reasoning).toBeUndefined();

    const run = hook.result.current.run({ input: 'hi' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve(json({ ...agentResponse('hello'), reasoning: 'Considered greetings' }));
    await run;
    await hook.flush();

    expect(hook.result.current.reasoning).toBe('Considered greetings');
    expect(hook.result.current.result?.reasoning).toBe('Considered greetings');

    hook.result.current.reset();
    await hook.flush();
    expect(hook.result.current.reasoning).toBeUndefined();
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

describe('useCogitatorAgent approvals', () => {
  const approval = {
    toolCallId: 'call_1',
    toolName: 'refund',
    arguments: { order: 'A-1' },
    description: 'Refund an order',
  };

  function installFetch(replies: Response[]) {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        const reply = replies[calls.length - 1];
        if (!reply) throw new Error(`Unexpected request to ${url}`);
        return reply;
      })
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the pending approvals of a paused result and resumes it', async () => {
    const calls = installFetch([
      json({ ...agentResponse('Let me refund'), status: 'paused', pendingApprovals: [approval] }),
      json({ ...agentResponse('Refunded'), status: 'completed' }),
    ]);
    const hook = renderHook(() =>
      useCogitatorAgent({ api: '/api/agent', resumeApi: '/api/agent/resume' })
    );
    expect(hook.result.current.pendingApprovals).toEqual([]);

    await hook.result.current.run({ input: 'Refund A-1' });
    await hook.flush();
    expect(hook.result.current.pendingApprovals).toEqual([approval]);
    expect(hook.result.current.result?.status).toBe('paused');

    await hook.result.current.resume({ decisions: { call_1: { approved: true } } });
    await hook.flush();

    expect(calls[1]).toEqual({
      url: '/api/agent/resume',
      body: { threadId: 'thread_1', decisions: { call_1: { approved: true } } },
    });
    expect(hook.result.current.result?.output).toBe('Refunded');
    expect(hook.result.current.pendingApprovals).toEqual([]);
  });

  it('reports an error when it cannot resume', async () => {
    const calls = installFetch([]);
    const onError = vi.fn();
    const withoutApi = renderHook(() => useCogitatorAgent({ api: '/api/agent', onError }));

    await withoutApi.result.current.resume({ defaultDecision: { approved: true } });
    await withoutApi.flush();
    expect(withoutApi.result.current.error?.message).toBe(
      'useCogitatorAgent needs resumeApi to resume a paused run'
    );

    const withoutResult = renderHook(() =>
      useCogitatorAgent({ api: '/api/agent', resumeApi: '/api/agent/resume' })
    );
    await withoutResult.result.current.resume({ defaultDecision: { approved: true } });
    await withoutResult.flush();
    expect(withoutResult.result.current.error?.message).toBe(
      'There is no result with a paused run to resume'
    );
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledOnce();
  });
});
