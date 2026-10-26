import { describe, it, expect } from 'vitest';
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
  type ConformanceServerOptions,
} from '@cogitator-ai/server-shared';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions } from '../types.js';

type Options = CogitatorAppOptions;

function serverOptions(server: ConformanceServerOptions = {}): Partial<Options> {
  const { forbiddenThreads, deps, ...options } = server;
  return {
    ...options,
    ...(forbiddenThreads && {
      authorizeThread: (_auth, id) => !forbiddenThreads.includes(id),
    }),
    ...(deps && { deps: () => deps }),
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

  const send = async (
    path: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<ConformanceResponse> => {
    const res = await app.request(path, {
      method: conformanceMethod(testCase),
      headers: { 'Content-Type': conformanceContentType(testCase), ...extraHeaders },
      body: testCase.body,
    });
    const body = await res.text();
    const code = res.ok ? undefined : (JSON.parse(body) as { error: { code: string } }).error.code;
    const headers = Object.fromEntries(
      [...res.headers.entries()].map(([name, value]) => [name.toLowerCase(), value])
    );
    return { status: res.status, code, body, headers };
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
