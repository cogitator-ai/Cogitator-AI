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
  conformanceReconnectRequest,
  type ConformanceCase,
  type ConformanceResponse,
  type ConformanceServerOptions,
} from '@cogitator-ai/server-shared';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';

/**
 * A Tetsu application answers every body that breaks the request schema with its validation
 * envelope: `VALIDATION_FAILED`, under the default validation status `422`.
 */
const TETSU_CONVENTIONS = { codes: { INVALID_INPUT: 'VALIDATION_FAILED' }, statuses: { 400: 422 } };

function serverOptions(server: ConformanceServerOptions = {}): Partial<CogitatorDeps> {
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
            ...serverOptions(testCase.server),
          }),
        ],
      }),
      reportError: () => undefined,
    })
  );

  const method = conformanceMethod(testCase);
  const send = async (
    path: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<ConformanceResponse> => {
    const res = await request(`/api${path}`, {
      method,
      headers: { 'content-type': conformanceContentType(testCase), ...extraHeaders },
      ...(method === 'POST' && { body: testCase.body }),
    });
    const body = await res.text();
    const code = res.ok ? undefined : (JSON.parse(body) as { error: string }).error;
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
  for (const testCase of CONFORMANCE_CASES) {
    test(testCase.name, async () => {
      const runtime = new ConformanceRuntime(testCase);
      const response = await answer(testCase, runtime);
      expect(checkConformance(testCase, response, runtime, TETSU_CONVENTIONS)).toEqual([]);
    });
  }
});
