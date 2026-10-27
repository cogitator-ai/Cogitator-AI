import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import type { AddressInfo } from 'node:net';
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
  type ConformanceServerOptions,
} from '@cogitator-ai/server-shared';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';
import { serve } from './local-server';

type Options = CogitatorAppOptions;

function serverOptions(server: ConformanceServerOptions = {}): Partial<Options> {
  const {
    acceptContext,
    threadMessageRoles,
    limits,
    anonymous,
    workflowCheckpoints,
    callers,
    deps,
  } = server;
  const authorizeThread = conformanceAuthorizeThread(server);
  const resumableStreams = conformanceResumableStreams(server);
  return {
    ...(acceptContext !== undefined && { acceptContext }),
    ...(threadMessageRoles && { threadMessageRoles }),
    ...(limits && { limits }),
    ...(anonymous && { anonymous }),
    ...(workflowCheckpoints && { workflowCheckpoints }),
    ...(callers && { auth: (ctx) => conformanceCaller((name) => ctx.get(name) || undefined) }),
    ...(authorizeThread && { authorizeThread }),
    ...(deps && { deps: () => deps }),
    ...(resumableStreams !== undefined && { resumableStreams }),
  };
}

async function answer(testCase: ConformanceCase, runtime: ConformanceRuntime) {
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({
    cogitator: runtime as unknown as Options['cogitator'],
    agents: {
      [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
    } as unknown as Options['agents'],
    swarms: { [CONFORMANCE_NAMES.swarm]: CONFORMANCE_SWARM } as unknown as Options['swarms'],
    workflows: {
      [CONFORMANCE_NAMES.workflow]: { name: 'flow', entryPoint: 'a', nodes: new Map() },
    } as unknown as Options['workflows'],
    sseHeartbeatMs: 0,
    ...serverOptions(testCase.server),
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  const { port } = (await serve(app)).address() as AddressInfo;

  return runConformanceCase(testCase, runtime, (request) =>
    sendConformanceRequest(request, (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init))
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
