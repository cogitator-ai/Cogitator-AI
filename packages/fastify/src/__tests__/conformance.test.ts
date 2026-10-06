import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
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
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

type Options = CogitatorPluginOptions;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

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
    ...testCase.server,
  });

  const res = await app.inject({
    method: conformanceMethod(testCase),
    url: `/api${CONFORMANCE_ROUTES[testCase.route]}`,
    headers: { 'content-type': conformanceContentType(testCase) },
    payload: testCase.body,
  });
  const ok = res.statusCode < 400;
  const code = ok ? undefined : (res.json() as { error: { code: string } }).error.code;
  return { status: res.statusCode, code, body: res.body };
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
