import { describe, expect, it, vi } from 'vitest';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import {
  AGUIConformanceRuntime,
  AGUI_CONFORMANCE_THREAD,
  aguiConformanceInput,
  runAGUIConformance,
} from '@cogitator-ai/server-shared/agui';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { createAGUIHandler } from '../handlers/agui.js';

const agent = { name: CONFORMANCE_NAMES.agent, config: { tools: [] } } as unknown as Agent;

/** A runtime whose run lasts until its signal aborts */
class LongRunRuntime extends AGUIConformanceRuntime {
  override run(_agent: unknown, options: RunOptions): Promise<RunResult> {
    this.aguiRuns.push(options);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
  }
}

async function startLongRun(hook: AbortController) {
  const runtime = new LongRunRuntime();
  const handler = createAGUIHandler(runtime as unknown as Cogitator, agent, {
    sseHeartbeatMs: 0,
    beforeRun: async () => ({ signal: hook.signal }),
  });
  const client = new AbortController();
  const response = await handler(
    new Request('http://localhost/api/agui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(aguiConformanceInput()),
      signal: client.signal,
    })
  );
  await vi.waitFor(() => expect(runtime.aguiRuns).toHaveLength(1));
  const signal = runtime.aguiRuns[0]?.signal;
  if (!signal) throw new Error('The run got no signal');
  return { client, signal, response };
}

describe('createAGUIHandler', () => {
  it('streams AG-UI events for a run and its resume', async () => {
    const runtime = new AGUIConformanceRuntime();
    const handler = createAGUIHandler(runtime as unknown as Cogitator, agent, {
      sseHeartbeatMs: 0,
      beforeRun: async () => ({ userId: 'user_1' }),
    });

    const problems = await runAGUIConformance(runtime, (request) =>
      sendConformanceRequest(request, (path, init) =>
        path === `/agents/${CONFORMANCE_NAMES.agent}/agui`
          ? handler(new Request('http://localhost/api/agui', init))
          : new Response(JSON.stringify({ error: { message: 'Not found', code: 'NOT_FOUND' } }), {
              status: 404,
            })
      )
    );
    expect(problems).toEqual([]);
    expect(runtime.aguiRuns[0]?.userId).toBe('user_1');
    expect(runtime.aguiResumes[0]?.userId).toBe('user_1');
  });

  it('runs, resumes and authorizes the thread beforeRun maps the AG-UI thread to', async () => {
    const runtime = new AGUIConformanceRuntime();
    const authorized: string[] = [];
    const handler = createAGUIHandler(runtime as unknown as Cogitator, agent, {
      sseHeartbeatMs: 0,
      beforeRun: async (_req, input) => ({ threadId: `tenant_1:${input.threadId}` }),
      authorizeThread: async (_req, threadId) => {
        authorized.push(threadId);
        return true;
      },
    });

    await runAGUIConformance(runtime, (request) =>
      sendConformanceRequest(request, (path, init) =>
        path === `/agents/${CONFORMANCE_NAMES.agent}/agui`
          ? handler(new Request('http://localhost/api/agui', init))
          : new Response(JSON.stringify({ error: { message: 'Not found', code: 'NOT_FOUND' } }), {
              status: 404,
            })
      )
    );
    const mapped = `tenant_1:${AGUI_CONFORMANCE_THREAD}`;
    expect(runtime.aguiRuns).toHaveLength(1);
    expect(runtime.aguiRuns[0]?.threadId).toBe(mapped);
    expect(runtime.aguiResumes[0]?.threadId).toBe(mapped);
    expect(new Set(authorized)).toEqual(new Set([mapped]));
  });

  it('stops the run when the client leaves, even with a signal from beforeRun', async () => {
    const hook = new AbortController();
    const { client, signal, response } = await startLongRun(hook);
    expect(signal.aborted).toBe(false);
    client.abort();
    expect(signal.aborted).toBe(true);
    await response.body?.cancel();
  });

  it('stops the run when the signal from beforeRun aborts', async () => {
    const hook = new AbortController();
    const { client, signal, response } = await startLongRun(hook);
    hook.abort();
    expect(signal.aborted).toBe(true);
    client.abort();
    await response.body?.cancel();
  });
});
