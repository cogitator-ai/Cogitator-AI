import { describe, it, expect } from 'vitest';
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
import type { CogitatorAppOptions } from '../types.js';

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
    ...(callers && { auth: (c) => conformanceCaller((name) => c.req.header(name)) }),
    ...(authorizeThread && { authorizeThread }),
    ...(deps && { deps: () => deps }),
    ...(resumableStreams !== undefined && { resumableStreams }),
  };
}

async function answer(testCase: ConformanceCase, runtime: ConformanceRuntime) {
  const app = cogitatorApp({
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

  return runConformanceCase(testCase, runtime, (request) =>
    sendConformanceRequest(request, (path, init) => app.request(path, init))
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
