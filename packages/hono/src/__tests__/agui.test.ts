import { describe, expect, it } from 'vitest';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import { AGUIConformanceRuntime, runAGUIConformance } from '@cogitator-ai/server-shared/agui';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions } from '../types.js';

type Options = CogitatorAppOptions;

describe('AG-UI route', () => {
  it('streams AG-UI events for a run and its resume', async () => {
    const runtime = new AGUIConformanceRuntime();
    const app = cogitatorApp({
      cogitator: runtime as unknown as Options['cogitator'],
      agents: {
        [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
      } as unknown as Options['agents'],
      sseHeartbeatMs: 0,
    });

    const problems = await runAGUIConformance(runtime, (request) =>
      sendConformanceRequest(request, (path, init) => app.request(path, init))
    );
    expect(problems).toEqual([]);
  });
});
