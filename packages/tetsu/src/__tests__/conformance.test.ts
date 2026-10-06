import { describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
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
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';

/**
 * A Tetsu application answers every body that breaks the request schema with its validation
 * envelope: `VALIDATION_FAILED`, under the default validation status `422`.
 */
const TETSU_CONVENTIONS = { codes: { INVALID_INPUT: 'VALIDATION_FAILED' }, statuses: { 400: 422 } };

async function answer(testCase: ConformanceCase, runtime: ConformanceRuntime) {
  const request = serve(
    createApp({
      routes: group('/api', {
        children: [
          cogitatorController({
            cogitator: runtime as unknown as CogitatorDeps['cogitator'],
            agents: {
              [CONFORMANCE_NAMES.agent]: { name: CONFORMANCE_NAMES.agent, config: { tools: [] } },
            } as unknown as CogitatorDeps['agents'],
            swarms: {
              [CONFORMANCE_NAMES.swarm]: CONFORMANCE_SWARM,
            } as unknown as CogitatorDeps['swarms'],
            workflows: {
              [CONFORMANCE_NAMES.workflow]: { name: 'flow', entryPoint: 'a', nodes: new Map() },
            } as unknown as CogitatorDeps['workflows'],
            sseHeartbeatMs: 0,
            ...testCase.server,
          }),
        ],
      }),
    })
  );

  const method = conformanceMethod(testCase);
  const res = await request(`/api${CONFORMANCE_ROUTES[testCase.route]}`, {
    method,
    headers: { 'content-type': conformanceContentType(testCase) },
    ...(method === 'POST' && { body: testCase.body }),
  });
  const body = await res.text();
  const code = res.ok ? undefined : (JSON.parse(body) as { error: string }).error;
  return { status: res.status, code, body };
}

describe('server protocol conformance', () => {
  for (const testCase of CONFORMANCE_CASES) {
    test(testCase.name, async () => {
      const runtime = new ConformanceRuntime();
      const response = await answer(testCase, runtime);
      expect(checkConformance(testCase, response, runtime, TETSU_CONVENTIONS)).toEqual([]);
    });
  }
});
