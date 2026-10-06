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
  type ConformanceCase,
} from '@cogitator-ai/server-shared';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions } from '../types.js';

type Options = CogitatorAppOptions;

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
    ...testCase.server,
  });

  const res = await app.request(CONFORMANCE_ROUTES[testCase.route], {
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
