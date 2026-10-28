import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import { AGUIConformanceRuntime, runAGUIConformance } from '@cogitator-ai/server-shared/agui';
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

type Options = CogitatorPluginOptions;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('AG-UI route', () => {
  it('streams AG-UI events for a run and its resume', async () => {
    const runtime = new AGUIConformanceRuntime();
    app = Fastify({ logger: false });
    await app.register(cogitatorPlugin, {
      cogitator: runtime as unknown as Options['cogitator'],
      agents: {
        [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
      } as unknown as Options['agents'],
      prefix: '/api',
      sseHeartbeatMs: 0,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const problems = await runAGUIConformance(runtime, (request) =>
      sendConformanceRequest(request, (path, init) => fetch(`${address}/api${path}`, init))
    );
    expect(problems).toEqual([]);
  });
});
