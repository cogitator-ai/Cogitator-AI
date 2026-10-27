import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  CONFORMANCE_CASES,
  CONFORMANCE_NAMES,
  CONFORMANCE_SWARM,
  ConformanceRuntime,
  checkConformance,
  conformanceAuthorizeThread,
  conformanceCaller,
  conformanceResumableStreams,
  runConformanceCase,
  sendConformanceRequest,
  type ConformanceCase,
} from '@cogitator-ai/server-shared';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

type Cogitator = CogitatorServerConfig['cogitator'];
type Agents = NonNullable<CogitatorServerConfig['agents']>;
type Workflows = NonNullable<CogitatorServerConfig['workflows']>;
type Swarms = NonNullable<CogitatorServerConfig['swarms']>;

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

function serverOptions(testCase: ConformanceCase): CogitatorServerConfig['config'] {
  const {
    acceptContext,
    threadMessageRoles,
    limits,
    anonymous,
    workflowCheckpoints,
    callers,
    deps,
  } = testCase.server ?? {};
  const authorizeThread = conformanceAuthorizeThread(testCase.server);
  const resumableStreams = conformanceResumableStreams(testCase.server);
  return {
    ...(acceptContext !== undefined && { acceptContext }),
    ...(threadMessageRoles && { threadMessageRoles }),
    ...(limits && { limits }),
    ...(anonymous && { anonymous }),
    ...(workflowCheckpoints && { workflowCheckpoints }),
    ...(callers && { auth: (req) => conformanceCaller((name) => req.get(name)) }),
    ...(authorizeThread && { authorizeThread }),
    ...(deps && { deps: () => deps }),
    ...(resumableStreams !== undefined && { resumableStreams }),
  };
}

async function answer(testCase: ConformanceCase, runtime: ConformanceRuntime) {
  const app = express();
  const cogitatorServer = new CogitatorServer({
    app,
    cogitator: runtime as unknown as Cogitator,
    agents: {
      [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
    } as unknown as Agents,
    swarms: { [CONFORMANCE_NAMES.swarm]: CONFORMANCE_SWARM } as unknown as Swarms,
    workflows: {
      [CONFORMANCE_NAMES.workflow]: { name: 'flow', entryPoint: 'a', nodes: new Map() },
    } as unknown as Workflows,
    config: {
      basePath: '/api',
      enableSwagger: false,
      sseHeartbeatMs: 0,
      ...serverOptions(testCase),
    },
  });
  await cogitatorServer.init();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;

  return runConformanceCase(testCase, runtime, (request) =>
    sendConformanceRequest(request, (path, init) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, init)
    )
  );
}

describe('server protocol conformance', () => {
  it.each(CONFORMANCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const runtime = new ConformanceRuntime(testCase);
      const response = await answer(testCase, runtime);
      expect(checkConformance(testCase, response, runtime)).toEqual([]);
    }
  );
});
