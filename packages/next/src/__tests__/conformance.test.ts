import { describe, it, expect } from 'vitest';
import {
  CONFORMANCE_CASES,
  ConformanceRuntime,
  checkConformance,
  conformanceContentType,
  type ConformanceCase,
} from '@cogitator-ai/server-shared';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { createAgentHandler } from '../handlers/agent.js';
import { createResumeHandler } from '../handlers/resume.js';
import { createChatHandler } from '../handlers/chat.js';

const agent = { name: 'assistant', config: { tools: [] } } as unknown as Agent;

/**
 * Next serves an agent through route handlers, not the REST routes of the other adapters: a
 * run is `createAgentHandler`, a resume `createResumeHandler`. The cases for those two run
 * against them; the streaming cases run against `createChatHandler` in the next block.
 */
const handlers = {
  agentRun: (runtime: ConformanceRuntime, testCase: ConformanceCase) =>
    createAgentHandler(runtime as unknown as Cogitator, agent, {
      acceptContext: testCase.server?.acceptContext,
    }),
  agentResume: (runtime: ConformanceRuntime) =>
    createResumeHandler(runtime as unknown as Cogitator, agent),
} as const;

function isHandled(testCase: ConformanceCase): testCase is ConformanceCase & {
  route: keyof typeof handlers;
} {
  return testCase.route in handlers;
}

describe('server protocol conformance', () => {
  it.each(
    CONFORMANCE_CASES.filter(isHandled).map((testCase) => [testCase.name, testCase] as const)
  )('%s', async (_name, testCase) => {
    const runtime = new ConformanceRuntime();
    const handler = handlers[testCase.route](runtime, testCase);
    const res = await handler(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'Content-Type': conformanceContentType(testCase) },
        body: testCase.body,
      })
    );
    const body = await res.text();
    const code = res.ok ? undefined : (JSON.parse(body) as { code?: string }).code;
    expect(checkConformance(testCase, { status: res.status, code, body }, runtime)).toEqual([]);
  });
});

describe('chat stream conformance', () => {
  const stream = (body: unknown) => {
    const runtime = new ConformanceRuntime();
    const handler = createChatHandler(runtime as unknown as Cogitator, agent, {
      sseHeartbeatMs: 0,
    });
    return {
      runtime,
      answer: handler(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ),
    };
  };

  it.each([
    ['announces a new thread in the stream', undefined, true],
    ['streams on the thread the request named', 'thread-1', 'thread-1'],
  ] as const)('%s', async (name, threadId, streamThread) => {
    const { runtime, answer } = stream({
      messages: [{ role: 'user', content: 'hi' }],
      ...(threadId && { threadId }),
    });
    const res = await answer;
    const testCase: ConformanceCase = {
      name,
      route: 'agentStream',
      body: '',
      expect: { status: 200, streamThread },
    };
    expect(
      checkConformance(testCase, { status: res.status, body: await res.text() }, runtime)
    ).toEqual([]);
  });
});

describe('chat stream heartbeat', () => {
  it('writes comments while a run is silent, so idle timeouts do not cut the stream', async () => {
    const runtime = new ConformanceRuntime();
    const slow = {
      run: (agentArg: unknown, options: Parameters<ConformanceRuntime['run']>[1]) =>
        new Promise((resolve) => setTimeout(() => resolve(runtime.run(agentArg, options)), 120)),
    };
    const handler = createChatHandler(slow as unknown as Cogitator, agent, {
      sseHeartbeatMs: 20,
    });
    const res = await handler(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      })
    );
    const text = await res.text();

    expect(text.match(/^: keep-alive$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});
