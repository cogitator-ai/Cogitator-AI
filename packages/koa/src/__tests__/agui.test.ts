import { describe, expect, it } from 'vitest';
import Koa from 'koa';
import type { AddressInfo } from 'node:net';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import { AGUIConformanceRuntime, runAGUIConformance } from '@cogitator-ai/server-shared/agui';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';
import { serve } from './local-server';

type Options = CogitatorAppOptions;

describe('AG-UI route', () => {
  it('streams AG-UI events for a run and its resume', async () => {
    const runtime = new AGUIConformanceRuntime();
    const app = new Koa<CogitatorState>();
    const router = cogitatorApp({
      cogitator: runtime as unknown as Options['cogitator'],
      agents: {
        [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
      } as unknown as Options['agents'],
      sseHeartbeatMs: 0,
    });
    app.use(router.routes());
    app.use(router.allowedMethods());
    const { port } = (await serve(app)).address() as AddressInfo;

    const problems = await runAGUIConformance(runtime, (request) =>
      sendConformanceRequest(request, (path, init) =>
        fetch(`http://127.0.0.1:${port}${path}`, init)
      )
    );
    expect(problems).toEqual([]);
  });
});
