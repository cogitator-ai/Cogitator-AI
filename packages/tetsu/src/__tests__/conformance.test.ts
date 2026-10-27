import { describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import type { BaseCtx } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
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
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';

/**
 * A Tetsu application answers every body that breaks the request schema with its validation
 * envelope: `VALIDATION_FAILED`, under the default validation status `422`.
 */
const TETSU_CONVENTIONS = { codes: { INVALID_INPUT: 'VALIDATION_FAILED' }, statuses: { 400: 422 } };

function serverOptions(server: ConformanceServerOptions = {}): Partial<CogitatorDeps> {
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
    ...(callers && {
      auth: (ctx: BaseCtx) => conformanceCaller((name) => ctx.req.headers.get(name)),
    }),
    ...(authorizeThread && { authorizeThread }),
    ...(deps && { deps: () => deps }),
    ...(resumableStreams !== undefined && { resumableStreams }),
  };
}

/** The code of the Tetsu envelope, `{ status, message, error }` */
function tetsuCode(body: unknown): string | undefined {
  return typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
    ? body.error
    : undefined;
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

  return runConformanceCase(testCase, runtime, (sent) =>
    sendConformanceRequest(sent, (path, init) => request(`/api${path}`, init), tetsuCode)
  );
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
