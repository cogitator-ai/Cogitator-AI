import { describe, it, expect } from 'vitest';
import Koa from 'koa';
import request from 'supertest';
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
import type { CogitatorAppOptions, CogitatorState } from '../types.js';

type Options = CogitatorAppOptions;

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
    ...testCase.server,
  });
  app.use(router.routes());
  app.use(router.allowedMethods());

  const path = CONFORMANCE_ROUTES[testCase.route];
  const client = request(app.callback());
  const res = await (conformanceMethod(testCase) === 'GET' ? client.get(path) : client.post(path))
    .set('Content-Type', conformanceContentType(testCase))
    .buffer(true)
    .parse((response, done) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => done(null, text));
    })
    .send(testCase.body);
  const body = String(res.body);
  const code =
    res.status < 400 ? undefined : (JSON.parse(body) as { error: { code: string } }).error.code;
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
