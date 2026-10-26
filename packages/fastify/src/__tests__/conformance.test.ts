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
  conformanceReconnectRequest,
  type ConformanceCase,
  type ConformanceResponse,
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
  const { forbiddenThreads, deps, ...options } = testCase.server ?? {};
  return {
    ...options,
    ...(forbiddenThreads && {
      authorizeThread: (_auth, threadId) => !forbiddenThreads.includes(threadId),
    }),
    ...(deps && { deps: () => deps }),
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

  const send = async (
    path: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<ConformanceResponse> => {
    const res = await app!.inject({
      method: conformanceMethod(testCase),
      url: `/api${path}`,
      headers: {
        ...(testCase.body !== undefined && { 'content-type': conformanceContentType(testCase) }),
        ...extraHeaders,
      },
      ...(testCase.body !== undefined && { payload: testCase.body }),
    });
    const ok = res.statusCode < 400;
    const code = ok ? undefined : (res.json() as { error: { code: string } }).error.code;
    const headers = Object.fromEntries(
      Object.entries(res.headers).map(([name, value]) => [name.toLowerCase(), String(value)])
    );
    return { status: res.statusCode, code, body: res.body, headers };
  };

  const first = await send(CONFORMANCE_ROUTES[testCase.route]);
  const reconnect = conformanceReconnectRequest(testCase, first);
  return reconnect ? { ...first, reconnect: await send(reconnect.path, reconnect.headers) } : first;
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
