import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { CONFORMANCE_NAMES, sendConformanceRequest } from '@cogitator-ai/server-shared';
import { AGUIConformanceRuntime, runAGUIConformance } from '@cogitator-ai/server-shared/agui';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

type Cogitator = CogitatorServerConfig['cogitator'];
type Agents = NonNullable<CogitatorServerConfig['agents']>;

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

describe('AG-UI route', () => {
  it('streams AG-UI events for a run and its resume', async () => {
    const runtime = new AGUIConformanceRuntime();
    const app = express();
    const cogitatorServer = new CogitatorServer({
      app,
      cogitator: runtime as unknown as Cogitator,
      agents: {
        [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
      } as unknown as Agents,
      config: { basePath: '/api', enableSwagger: false, sseHeartbeatMs: 0 },
    });
    await cogitatorServer.init();
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = server.address() as AddressInfo;

    const problems = await runAGUIConformance(runtime, (request) =>
      sendConformanceRequest(request, (path, init) =>
        fetch(`http://127.0.0.1:${port}/api${path}`, init)
      )
    );
    expect(problems).toEqual([]);
  });
});
