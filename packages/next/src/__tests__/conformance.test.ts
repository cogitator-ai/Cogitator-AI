import { describe, it, expect, vi, onTestFinished } from 'vitest';
import {
  CONFORMANCE_CASES,
  ConformanceRuntime,
  checkConformance,
  conformanceAuthorizeThread,
  conformanceCaller,
  conformanceResumableStreams,
  defaultStreamOwner,
  runConformanceCase,
  sendConformanceRequest,
  type ConformanceCase,
  type ConformanceResponse,
  type ResumableStreamOptions,
} from '@cogitator-ai/server-shared';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { createAgentHandler } from '../handlers/agent.js';
import { createResumeHandler } from '../handlers/resume.js';
import { createChatHandler } from '../handlers/chat.js';

const agent = { name: 'assistant', config: { tools: [] } } as unknown as Agent;

/**
 * Next serves an agent through route handlers, not the REST routes of the other adapters: a
 * run is `createAgentHandler`, a resume `createResumeHandler` (with `stream: true` for a resume
 * over SSE). The cases for those run against them, and the streaming cases run against `createChatHandler` in the next block.
 */
/** The identity a request of a case carries */
const callerOf = (req: Request) => conformanceCaller((name) => req.headers.get(name));

/** The handler options a case's server options map to */
function contractOf(testCase: ConformanceCase) {
  const server = testCase.server ?? {};
  const { anonymous, deps } = server;
  const authorize = conformanceAuthorizeThread(server);
  return {
    ...(anonymous && { anonymous }),
    ...(authorize && {
      authorizeThread: (req: Request, threadId: string) => authorize(callerOf(req), threadId),
    }),
    ...(deps && { deps: () => deps }),
  };
}

/**
 * The `resumableStreams` of a case for a Next handler, whose `owner` reads the request: the
 * identity of a case with `callers`, by the same rules as the other adapters
 */
function resumableStreamsOf(
  testCase: ConformanceCase
): boolean | ResumableStreamOptions<Request> | undefined {
  const server = testCase.server;
  if (!server?.callers) return server?.resumableStreams;
  const option = conformanceResumableStreams(server);
  if (!option) return option;
  const { owner, ...options } = option === true ? {} : option;
  return {
    ...options,
    owner: (req) => {
      const caller = req && callerOf(req);
      return owner ? owner(caller) : defaultStreamOwner(caller);
    },
  };
}

const handlers = {
  agentRun: (runtime: ConformanceRuntime, testCase: ConformanceCase) =>
    createAgentHandler(runtime as unknown as Cogitator, agent, {
      acceptContext: testCase.server?.acceptContext,
      ...contractOf(testCase),
    }),
  agentResume: (runtime: ConformanceRuntime, testCase: ConformanceCase) =>
    createResumeHandler(runtime as unknown as Cogitator, agent, contractOf(testCase)),
  agentResumeStream: (runtime: ConformanceRuntime, testCase: ConformanceCase) =>
    createResumeHandler(runtime as unknown as Cogitator, agent, {
      ...contractOf(testCase),
      stream: true,
      sseHeartbeatMs: 0,
      resumableStreams: resumableStreamsOf(testCase),
    }),
} as const;

/**
 * Sends a case to a handler, and its follow-ups: the route of a request decides nothing for a
 * route handler, only its query does, and a cancel goes to the same handler as `DELETE` with
 * `?streamId=`
 */
function answer(
  handler: (req: Request) => Promise<Response>,
  testCase: ConformanceCase,
  runtime: ConformanceRuntime,
  body?: string
): Promise<ConformanceResponse> {
  return runConformanceCase(testCase, runtime, (request) =>
    sendConformanceRequest(
      body === undefined || request.body === undefined ? request : { ...request, body },
      (path, init) => {
        const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
        const cancel = init.method === 'DELETE' && path.startsWith('/agents/');
        const url = cancel
          ? `http://localhost/api?streamId=${path.slice(path.lastIndexOf('/') + 1)}`
          : `http://localhost/api${query}`;
        return handler(new Request(url, init));
      }
    )
  );
}

function isHandled(testCase: ConformanceCase): testCase is ConformanceCase & {
  route: keyof typeof handlers;
} {
  return testCase.route in handlers;
}

describe('server protocol conformance', () => {
  it.each(
    CONFORMANCE_CASES.filter(isHandled).map((testCase) => [testCase.name, testCase] as const)
  )('%s', async (_name, testCase) => {
    const runtime = new ConformanceRuntime(testCase);
    const handler = handlers[testCase.route](runtime, testCase);
    expect(checkConformance(testCase, await answer(handler, testCase, runtime), runtime)).toEqual(
      []
    );
  });
});

describe('chat stream resumable conformance', () => {
  const cases = CONFORMANCE_CASES.filter(
    (testCase) => testCase.route === 'agentStream' && testCase.expect.streamIds !== undefined
  );

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const runtime = new ConformanceRuntime(testCase);
      const handler = createChatHandler(runtime as unknown as Cogitator, agent, {
        ...contractOf(testCase),
        sseHeartbeatMs: 0,
        resumableStreams: resumableStreamsOf(testCase),
      });
      const { input } = JSON.parse(testCase.body ?? '{}') as { input: string };
      const body = JSON.stringify({ messages: [{ role: 'user', content: input }] });
      expect(
        checkConformance(testCase, await answer(handler, testCase, runtime, body), runtime)
      ).toEqual([]);
    }
  );
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
  function afterHeartbeats(intervalMs: number, beats: number): Promise<void> {
    const realSetInterval = globalThis.setInterval;
    let ticks = 0;
    return new Promise((resolve) => {
      const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, ms, ...args) =>
        ms === intervalMs
          ? realSetInterval(() => {
              callback(...args);
              if (++ticks === beats) resolve();
            }, ms)
          : realSetInterval(callback, ms, ...args)
      );
      onTestFinished(() => spy.mockRestore());
    });
  }

  it('writes comments while a run is silent, so idle timeouts do not cut the stream', async () => {
    const runtime = new ConformanceRuntime();
    const heartbeats = afterHeartbeats(20, 3);
    const slow = {
      run: async (agentArg: unknown, options: Parameters<ConformanceRuntime['run']>[1]) => {
        await heartbeats;
        return runtime.run(agentArg, options);
      },
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
