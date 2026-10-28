import { describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import { AGUIConformanceRuntime, runAGUIConformance } from '@cogitator-ai/server-shared/agui';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';

describe('AG-UI route', () => {
  test('streams AG-UI events for a run and its resume', async () => {
    const runtime = new AGUIConformanceRuntime();
    const request = serve(
      createApp({
        routes: group('/api', {
          children: [
            cogitatorController({
              cogitator: runtime as unknown as CogitatorDeps['cogitator'],
              agents: {
                [CONFORMANCE_NAMES.agent]: {
                  name: CONFORMANCE_NAMES.agent,
                  config: { tools: [] },
                },
              } as unknown as CogitatorDeps['agents'],
              sseHeartbeatMs: 0,
            }),
          ],
        }),
        reportError: () => undefined,
      })
    );

    const problems = await runAGUIConformance(
      runtime,
      (sent) => sendConformanceRequest(sent, (path, init) => request(`/api${path}`, init)),
      { statuses: { 400: 422 } }
    );
    expect(problems).toEqual([]);
  });
});
