import { describe, expect, it } from 'vitest';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import { AGUIConformanceRuntime, runAGUIConformance } from '@cogitator-ai/server-shared/agui';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { createAGUIHandler } from '../handlers/agui.js';

const agent = { name: CONFORMANCE_NAMES.agent, config: { tools: [] } } as unknown as Agent;

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
});
