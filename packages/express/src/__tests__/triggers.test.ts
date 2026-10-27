import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  ConformanceTriggers,
  TRIGGER_CONFORMANCE_CASES,
  checkTriggerConformanceCase,
  conformanceCaller,
  type TriggerConformanceCase,
} from '@cogitator-ai/server-shared';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

async function answer(testCase: TriggerConformanceCase, host: ConformanceTriggers) {
  const app = express();
  const cogitatorServer = new CogitatorServer({
    app,
    cogitator: {} as CogitatorServerConfig['cogitator'],
    ...(testCase.server?.triggers !== false && { triggers: host }),
    config: {
      basePath: '/api',
      enableSwagger: false,
      auth: (req) => conformanceCaller((name) => req.get(name)),
      ...(testCase.server?.anonymous && { anonymous: testCase.server.anonymous }),
    },
  });
  await cogitatorServer.init();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api${testCase.path}`, {
    method: testCase.method,
    headers: testCase.headers,
    ...(testCase.body !== undefined && { body: testCase.body }),
  });
  return { status: response.status, body: await response.text() };
}

describe('trigger and inbox routes', () => {
  it.each(TRIGGER_CONFORMANCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const host = new ConformanceTriggers();
      const response = await answer(testCase, host);
      expect(checkTriggerConformanceCase(testCase, response, host)).toEqual([]);
    }
  );
});
