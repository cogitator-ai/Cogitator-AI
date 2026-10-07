import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  CONFORMANCE_CASES,
  CONFORMANCE_NAMES,
  CONFORMANCE_ROUTES,
  CONFORMANCE_SWARM,
  ConformanceRuntime,
  checkConformance,
  conformanceContentType,
  conformanceMethod,
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
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

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
      ...testCase.server,
    },
  });
  await cogitatorServer.init();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/api${CONFORMANCE_ROUTES[testCase.route]}`, {
    method: conformanceMethod(testCase),
    headers: { 'Content-Type': conformanceContentType(testCase) },
    body: testCase.body,
  });
  const body = await res.text();
  const code = res.ok ? undefined : (JSON.parse(body) as { error: { code: string } }).error.code;
  return { status: res.status, code, body };
}

describe('server protocol conformance', () => {
  it.each(CONFORMANCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const runtime = new ConformanceRuntime();
      const response = await answer(testCase, runtime);
      expect(checkConformance(testCase, response, runtime)).toEqual([]);
    }
  );
});
