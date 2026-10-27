import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

type Options = CogitatorPluginOptions;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function pluginOptions(testCase: ConformanceCase): Partial<Options> {
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
    ...(callers && {
      auth: (request: FastifyRequest) =>
        conformanceCaller((name) => {
          const value = request.headers[name];
          return typeof value === 'string' ? value : undefined;
        }),
    }),
    ...(authorizeThread && { authorizeThread }),
    ...(deps && { deps: () => deps }),
    ...(resumableStreams !== undefined && { resumableStreams }),
  };
}

async function answer(testCase: ConformanceCase, runtime: ConformanceRuntime) {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator: runtime as unknown as Options['cogitator'],
    agents: {
      [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
    } as unknown as Options['agents'],
    swarms: { [CONFORMANCE_NAMES.swarm]: CONFORMANCE_SWARM } as unknown as Options['swarms'],
    workflows: {
      [CONFORMANCE_NAMES.workflow]: { name: 'flow', entryPoint: 'a', nodes: new Map() },
    } as unknown as Options['workflows'],
    prefix: '/api',
    sseHeartbeatMs: 0,
    ...pluginOptions(testCase),
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });

  return runConformanceCase(testCase, runtime, (request) =>
    sendConformanceRequest(request, (path, init) => fetch(`${address}/api${path}`, init))
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
