import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createApp } from '@tetsujs/core';
import type { FailureReport } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps, WebSocketServerMessage } from '../index.js';
import { Agent } from '@cogitator-ai/core';
import { Swarm, SwarmTimeoutError } from '@cogitator-ai/swarms';
import { WorkflowBuilder, WorkflowExecutor } from '@cogitator-ai/workflows';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type { Workflow, WorkflowState } from '@cogitator-ai/types';
import {
  chatAgent,
  deferred,
  fakeCogitator,
  lastResumeCall,
  lastRunOptions,
  pausedResult,
  refundApproval,
  runResult,
} from './helpers.js';

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

function serveSockets(
  deps: Omit<CogitatorDeps, 'websocket'>,
  reports: FailureReport[] = [],
  websocket: CogitatorDeps['websocket'] = true
) {
  return serve(
    createApp({
      routes: cogitatorController({ ...deps, websocket }),
      reportError: (report) => {
        reports.push(report);
      },
    })
  );
}

interface Connection {
  socket: WebSocket;
  next(): Promise<WebSocketServerMessage>;
  until(type: string): Promise<WebSocketServerMessage[]>;
  send(message: unknown): void;
  closed: Promise<CloseEvent>;
}

async function connect(baseUrl: URL, headers?: Record<string, string>): Promise<Connection> {
  const url = new URL('/ws', baseUrl);
  url.protocol = 'ws:';
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const inbox: WebSocketServerMessage[] = [];
  const waiting: Array<(message: WebSocketServerMessage) => void> = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as WebSocketServerMessage;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener('close', resolve, { once: true })
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('handshake refused')), { once: true });
  });

  const next = () =>
    new Promise<WebSocketServerMessage>((resolve) => {
      const queued = inbox.shift();
      if (queued) resolve(queued);
      else waiting.push(resolve);
    });

  return {
    socket,
    next,
    async until(type) {
      const received: WebSocketServerMessage[] = [];
      for (;;) {
        const message = await next();
        received.push(message);
        const payloadType = (message.payload as { type?: string } | undefined)?.type;
        if (message.type === type || payloadType === type) return received;
      }
    },
    send: (message) => socket.send(JSON.stringify(message)),
    closed,
  };
}

describe('websocket', () => {
  test('answers a ping', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveSockets({ cogitator });
    const connection = await connect(request.url);

    connection.send({ type: 'ping', id: 'p-1' });

    expect(await connection.next()).toEqual({ type: 'pong', id: 'p-1' });
  });

  test('streams an agent run and completes it', async () => {
    const { cogitator, run } = fakeCogitator(async (_agent, options) => {
      options.onToken?.('Hi');
      options.onToolCall?.({ id: 'c-1', name: 'get_weather', arguments: { city: 'Oslo' } });
      options.onToolResult?.({ callId: 'c-1', name: 'get_weather', result: 'Cold' });
      return runResult({ output: 'Hi there' });
    });
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'hello', threadId: 't-9' },
    });
    const received = await connection.until('complete');

    expect(received.map((message) => (message.payload as { type: string }).type)).toEqual([
      'token',
      'tool-call',
      'tool-result',
      'complete',
    ]);
    expect(received.every((message) => message.id === 'r-1')).toBe(true);
    expect(received.at(-1)?.payload).toMatchObject({ result: { output: 'Hi there' } });
    expect(lastRunOptions(run).threadId).toBe('t-9');
  });

  test('sends reasoning deltas of an agent run', async () => {
    const { cogitator } = fakeCogitator(async (_agent, options) => {
      options.onReasoning?.('Plan');
      options.onToken?.('Hi');
      return runResult({ output: 'Hi', reasoning: 'Plan' });
    });
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'hello' },
    });
    const received = await connection.until('complete');

    expect(received.map((message) => message.payload)).toEqual([
      { type: 'reasoning', delta: 'Plan' },
      { type: 'token', delta: 'Hi' },
      expect.objectContaining({
        type: 'complete',
        result: expect.objectContaining({ output: 'Hi', reasoning: 'Plan' }),
      }),
    ]);
  });

  test('runs agents side by side by id, and stops only the run a stop names', async () => {
    const signals = new Map<string, AbortSignal>();
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((resolve, reject) => {
          const input = String(options.input);
          if (options.signal) signals.set(input, options.signal);
          options.onToken?.(`working on ${input}`);
          if (input === 'quick') {
            resolve(runResult({ output: 'done quick' }));
            return;
          }
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);
    const run = (id: string, input: string) =>
      connection.send({ type: 'run', id, payload: { type: 'agent', name: 'chat', input } });

    run('slow-1', 'slow-1');
    run('slow-2', 'slow-2');
    run('quick', 'quick');
    const untilQuick = await connection.until('complete');
    expect(untilQuick.at(-1)).toMatchObject({ id: 'quick', payload: { type: 'complete' } });

    connection.send({ type: 'stop', id: 'slow-1' });
    expect(await connection.next()).toEqual({
      type: 'event',
      id: 'slow-1',
      payload: { type: 'cancelled' },
    });
    expect(signals.get('slow-1')?.aborted).toBe(true);
    expect(signals.get('slow-2')?.aborted).toBe(false);

    connection.send({ type: 'ping', id: 'still-there' });
    expect(await connection.until('pong')).toEqual([{ type: 'pong', id: 'still-there' }]);
  });

  test('refuses a run whose id is already running, and one more run without an id', async () => {
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('working');
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);
    const payload = { type: 'agent', name: 'chat', input: 'go' };

    connection.send({ type: 'run', id: 'r-1', payload });
    await connection.next();
    connection.send({ type: 'run', id: 'r-1', payload });
    expect(await connection.next()).toMatchObject({
      type: 'error',
      id: 'r-1',
      code: 'RUN_IN_PROGRESS',
    });

    connection.send({ type: 'run', payload });
    await connection.next();
    connection.send({ type: 'run', payload });
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'RUN_IN_PROGRESS' });
  });

  test('stops every run of the socket on a stop without an id', async () => {
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('working');
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);
    for (const id of ['a', 'b']) {
      connection.send({ type: 'run', id, payload: { type: 'agent', name: 'chat', input: id } });
      await connection.next();
    }

    connection.send({ type: 'stop' });

    const cancelled = [await connection.next(), await connection.next()];
    expect(cancelled.map((message) => message.id).sort()).toEqual(['a', 'b']);
    for (const message of cancelled) expect(message.payload).toEqual({ type: 'cancelled' });
  });

  test('refuses a run past maxRuns until one of them ends', async () => {
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('working');
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } }, [], {
      maxRuns: 2,
    });
    const connection = await connect(request.url);
    const run = (id: string) =>
      connection.send({ type: 'run', id, payload: { type: 'agent', name: 'chat', input: id } });

    run('a');
    await connection.next();
    run('b');
    await connection.next();
    run('c');
    expect(await connection.next()).toMatchObject({
      type: 'error',
      id: 'c',
      code: 'TOO_MANY_RUNS',
    });

    connection.send({ type: 'stop', id: 'a' });
    expect(await connection.next()).toMatchObject({ id: 'a', payload: { type: 'cancelled' } });
    run('c');
    expect(await connection.next()).toMatchObject({ id: 'c', payload: { type: 'token' } });
  });

  test.each([
    [{ maxRuns: 0 }, 'websocket.maxRuns must be a positive integer'],
    [{ maxRuns: 1.5 }, 'websocket.maxRuns must be a positive integer'],
    [{ maxBufferedBytes: -1 }, 'websocket.maxBufferedBytes must be a positive integer'],
  ])('refuses websocket options %p when the controller is built', (websocket, message) => {
    const { cogitator } = fakeCogitator();
    expect(() => cogitatorController({ cogitator, websocket })).toThrow(message);
  });

  test('aborts a run when the socket closes', async () => {
    let runSignal: AbortSignal | undefined;
    const { cogitator } = fakeCogitator(
      (_agent, options) =>
        new Promise(() => {
          runSignal = options.signal;
          options.onToken?.('working');
        })
    );
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: 'go' } });
    await connection.next();
    connection.socket.close();
    await connection.closed;

    for (let i = 0; i < 50 && !runSignal?.aborted; i++) await Bun.sleep(10);
    expect(runSignal?.aborted).toBe(true);
  });

  test('refuses a whitespace-only input before the model is called', async () => {
    const { cogitator, run } = fakeCogitator();
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: '   ' } });
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
    expect(run).not.toHaveBeenCalled();
  });

  test('refuses a context the server does not accept, and passes the keys it does', async () => {
    const { cogitator, run } = fakeCogitator();
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      acceptContext: ['lang'],
    });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      payload: { type: 'agent', name: 'chat', input: 'hi', context: { policy: 'refunds ok' } },
    });
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
    expect(run).not.toHaveBeenCalled();

    connection.send({
      type: 'run',
      payload: { type: 'agent', name: 'chat', input: 'hi', context: { lang: 'en' } },
    });
    await connection.until('complete');
    expect(lastRunOptions(run).context).toEqual({ lang: 'en' });
  });

  test('answers an invalid frame without closing the socket', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveSockets({ cogitator });
    const connection = await connect(request.url);

    connection.socket.send('not json');
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });

    connection.send({ type: 'run', payload: { type: 'robot', name: 'x', input: 'y' } });
    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });

    connection.send({ type: 'ping' });
    expect(await connection.next()).toEqual({ type: 'pong' });
  });

  test('reports an unknown agent as an error frame', async () => {
    const { cogitator } = fakeCogitator();
    const request = serveSockets({ cogitator });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'ghost', input: 'x' },
    });

    expect(await connection.next()).toEqual({
      type: 'error',
      id: 'r-1',
      error: "Agent 'ghost' not found",
      code: 'AGENT_NOT_FOUND',
    });
  });

  test('hides an unexpected failure and reports it', async () => {
    const reports: FailureReport[] = [];
    const { cogitator } = fakeCogitator(() => Promise.reject(new Error('secret detail')));
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } }, reports);
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'x' },
    });

    expect(await connection.next()).toEqual({
      type: 'error',
      id: 'r-1',
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
    for (let i = 0; i < 50 && reports.length === 0; i++) await Bun.sleep(10);
    expect(reports.map((report) => report.source)).toEqual(['websocket']);
  });

  test('runs the handshake through auth and passes the user to the run', async () => {
    const { cogitator, run } = fakeCogitator();
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      auth: (ctx) =>
        ctx.req.headers.get('authorization') === 'Bearer ada' ? { userId: 'ada' } : undefined,
    });

    const refused = await connect(request.url).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('handshake refused');

    const connection = await connect(request.url, { authorization: 'Bearer ada' });
    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: 'hi' } });
    await connection.until('complete');
    expect(lastRunOptions(run).userId).toBe('ada');
  });

  test('completes a paused run with its approvals and without the checkpoint', async () => {
    const { cogitator } = fakeCogitator(() => Promise.resolve(pausedResult()));
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'r-1',
      payload: { type: 'agent', name: 'chat', input: 'Refund A-1' },
    });
    const [complete] = await connection.until('complete');

    expect(complete?.payload).toEqual({
      type: 'complete',
      result: expect.objectContaining({ status: 'paused', pendingApprovals: [refundApproval] }),
    });
    expect(JSON.stringify(complete)).not.toContain('checkpoint');
  });

  test('resumes a paused run as the caller and streams the rest of it', async () => {
    const { cogitator, resume } = fakeCogitator(undefined, undefined, async (_agent, _id, opts) => {
      opts.onToken?.('Refunded');
      return runResult({ output: 'Refunded', status: 'completed' });
    });
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      auth: () => ({ userId: 'ada' }),
    });
    const connection = await connect(request.url);

    connection.send({
      type: 'resume',
      id: 'r-2',
      payload: {
        name: 'chat',
        threadId: 't-1',
        decisions: { 'call-1': { approved: false, reason: 'Too much' } },
      },
    });
    const received = await connection.until('complete');

    expect(received.map((message) => message.payload)).toEqual([
      { type: 'token', delta: 'Refunded' },
      {
        type: 'complete',
        result: expect.objectContaining({ output: 'Refunded', status: 'completed' }),
      },
    ]);
    expect(received.every((message) => message.id === 'r-2')).toBe(true);
    const { threadId, options } = lastResumeCall(resume);
    expect(threadId).toBe('t-1');
    expect(options.userId).toBe('ada');
    expect(options.decisions).toEqual({ 'call-1': { approved: false, reason: 'Too much' } });
  });

  test('reports a thread without a paused run as an error frame', async () => {
    const { cogitator } = fakeCogitator(undefined, undefined, async () => {
      throw new CogitatorError({ message: 'No paused run', code: ErrorCode.RUN_NOT_PAUSED });
    });
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({ type: 'resume', id: 'r-3', payload: { name: 'chat', threadId: 't-1' } });

    expect(await connection.next()).toEqual({
      type: 'error',
      id: 'r-3',
      error: 'No paused run',
      code: 'RUN_NOT_PAUSED',
    });
  });

  test('refuses a resume frame without a thread', async () => {
    const { cogitator, resume } = fakeCogitator();
    const request = serveSockets({ cogitator, agents: { chat: chatAgent() } });
    const connection = await connect(request.url);

    connection.send({ type: 'resume', payload: { name: 'chat' } });

    expect(await connection.next()).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
    expect(resume).not.toHaveBeenCalled();
  });

  test('is not served unless enabled', async () => {
    const { cogitator } = fakeCogitator();
    const request = serve(createApp({ routes: cogitatorController({ cogitator }) }));
    expect((await request('/ws')).status).toBe(404);
  });
});

describe('websocket server contract', () => {
  const team = {
    name: 'team',
    strategy: 'round-robin' as const,
    agents: [new Agent({ name: 'alpha', model: 'ollama/qwen3:0.6b', instructions: 'Hi.' })],
  };

  function steps(): Workflow<WorkflowState> {
    return new WorkflowBuilder('steps')
      .addNode('one', async () => ({ output: 'done' }))
      .build() as unknown as Workflow<WorkflowState>;
  }

  test('holds workflow and swarm runs to the limits', async () => {
    const execute = spyOn(WorkflowExecutor.prototype, 'execute');
    const swarmRun = spyOn(Swarm.prototype, 'run');
    try {
      const { cogitator } = fakeCogitator();
      const request = serveSockets({
        cogitator,
        workflows: { steps: steps() },
        swarms: { team },
        limits: { swarmTimeout: 1500, workflowMaxIterations: 10, workflowMaxConcurrency: 2 },
      });
      const connection = await connect(request.url);

      connection.send({
        type: 'run',
        id: 'w',
        payload: { type: 'workflow', name: 'steps', input: 'x' },
      });
      await connection.until('complete');
      connection.send({
        type: 'run',
        id: 's',
        payload: { type: 'swarm', name: 'team', input: 'go' },
      });
      await connection.until('complete');

      expect(execute.mock.calls[0]?.[2]).toMatchObject({ maxIterations: 10, maxConcurrency: 2 });
      expect(swarmRun.mock.calls[0]?.[0]).toMatchObject({ timeout: 1500 });
    } finally {
      execute.mockRestore();
      swarmRun.mockRestore();
    }
  });

  test('runs a workflow and a swarm side by side, answering each by its id', async () => {
    const request = serveSockets({
      cogitator: fakeCogitator(async () => runResult({ output: 'swarm answer' })).cogitator,
      workflows: { steps: steps() },
      swarms: { team },
    });
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'w',
      payload: { type: 'workflow', name: 'steps', input: 'x' },
    });
    connection.send({
      type: 'run',
      id: 's',
      payload: { type: 'swarm', name: 'team', input: 'go' },
    });
    const completed = new Map<string | undefined, unknown>();
    while (completed.size < 2) {
      const message = await connection.next();
      const payload = message.payload as { type?: string; result?: unknown } | undefined;
      if (payload?.type === 'complete') completed.set(message.id, payload.result);
    }

    expect(completed.get('w')).toMatchObject({ workflowName: 'steps', state: expect.anything() });
    expect(completed.get('s')).toMatchObject({ swarmName: 'team', output: 'swarm answer' });
  });

  test('stops a workflow run by its id and leaves a swarm run going', async () => {
    const nodeStarted = deferred<void>();
    const release = deferred<void>();
    const swarmStarted = deferred<void>();
    const held = new WorkflowBuilder('held')
      .addNode('wait', async () => {
        nodeStarted.resolve();
        await release.promise;
        return { output: 'released' };
      })
      .build() as unknown as Workflow<WorkflowState>;
    const swarmRun = spyOn(Swarm.prototype, 'run').mockImplementation(async () => {
      swarmStarted.resolve();
      await Bun.sleep(50);
      return { output: 'still answered', agentResults: new Map() };
    });
    try {
      const request = serveSockets({
        cogitator: fakeCogitator().cogitator,
        workflows: { held },
        swarms: { team },
      });
      const connection = await connect(request.url);

      connection.send({
        type: 'run',
        id: 'w',
        payload: { type: 'workflow', name: 'held', input: 'x' },
      });
      connection.send({
        type: 'run',
        id: 's',
        payload: { type: 'swarm', name: 'team', input: 'go' },
      });
      await Promise.all([nodeStarted.promise, swarmStarted.promise]);
      connection.send({ type: 'stop', id: 'w' });

      const ends = new Map<string | undefined, string | undefined>();
      while (ends.size < 2) {
        const message = await connection.next();
        const type = (message.payload as { type?: string } | undefined)?.type ?? message.type;
        if (type === 'cancelled' || type === 'complete' || type === 'error')
          ends.set(message.id, type);
      }
      expect(Object.fromEntries(ends)).toEqual({ w: 'cancelled', s: 'complete' });

      const again = {
        type: 'run',
        id: 'w',
        payload: { type: 'workflow', name: 'held', input: 'x' },
      };
      connection.send(again);
      expect(await connection.next()).toMatchObject({ id: 'w', code: 'RUN_IN_PROGRESS' });

      release.resolve();
      let answer: WebSocketServerMessage | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        connection.send(again);
        answer = await connection.next();
        if (answer.type !== 'error') break;
        await Bun.sleep(10);
      }
      expect(answer).toMatchObject({ id: 'w', payload: { type: 'complete' } });
    } finally {
      release.resolve();
      swarmRun.mockRestore();
    }
  });

  test('reports a swarm that ran out of time as a RUN_TIMEOUT error frame', async () => {
    const swarmRun = spyOn(Swarm.prototype, 'run').mockRejectedValue(
      new SwarmTimeoutError('team', 10)
    );
    try {
      const request = serveSockets({ cogitator: fakeCogitator().cogitator, swarms: { team } });
      const connection = await connect(request.url);

      connection.send({
        type: 'run',
        id: 's',
        payload: { type: 'swarm', name: 'team', input: 'go' },
      });

      expect(await connection.next()).toEqual({
        type: 'error',
        id: 's',
        error: "Swarm 'team' timed out after 10ms",
        code: 'RUN_TIMEOUT',
      });
    } finally {
      swarmRun.mockRestore();
    }
  });

  test('refuses the handshake of a caller without a user id under anonymous deny', async () => {
    const { cogitator, run } = fakeCogitator();
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      anonymous: 'deny',
      auth: (ctx) => {
        const user = ctx.req.headers.get('x-user');
        return user ? { userId: user } : {};
      },
    });

    const refused = await connect(request.url).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('handshake refused');
    const res = await request('/ws');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('UNAUTHORIZED');
    expect((await request('/health')).status).toBe(200);

    const connection = await connect(request.url, { 'x-user': 'ada' });
    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: 'hi' } });
    await connection.until('complete');
    expect(lastRunOptions(run).userId).toBe('ada');
  });

  test('refuses runs and resumes on a thread authorizeThread keeps the caller from', async () => {
    const swarmRun = spyOn(Swarm.prototype, 'run');
    try {
      const { cogitator, run, resume } = fakeCogitator();
      const request = serveSockets({
        cogitator,
        agents: { chat: chatAgent() },
        swarms: { team },
        authorizeThread: (_auth, threadId) => threadId !== 'locked',
      });
      const connection = await connect(request.url);
      const refusal = {
        type: 'error' as const,
        error: "Access to thread 'locked' is not allowed",
        code: 'THREAD_FORBIDDEN',
      };

      connection.send({
        type: 'run',
        id: 'a',
        payload: { type: 'agent', name: 'chat', input: 'hi', threadId: 'locked' },
      });
      expect(await connection.next()).toEqual({ ...refusal, id: 'a' });
      connection.send({ type: 'resume', id: 'r', payload: { name: 'chat', threadId: 'locked' } });
      expect(await connection.next()).toEqual({ ...refusal, id: 'r' });
      connection.send({
        type: 'run',
        id: 's',
        payload: { type: 'swarm', name: 'team', input: 'go', threadId: 'locked' },
      });
      expect(await connection.next()).toEqual({ ...refusal, id: 's' });

      expect(run).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(swarmRun).not.toHaveBeenCalled();
    } finally {
      swarmRun.mockRestore();
    }
  });

  test('answers an authorizeThread that throws with an error frame and starts no run', async () => {
    const reports: FailureReport[] = [];
    const { cogitator, run } = fakeCogitator();
    const request = serveSockets(
      {
        cogitator,
        agents: { chat: chatAgent() },
        authorizeThread: () => {
          throw new Error('policy store down');
        },
      },
      reports
    );
    const connection = await connect(request.url);

    connection.send({
      type: 'run',
      id: 'a',
      payload: { type: 'agent', name: 'chat', input: 'hi', threadId: 't-1' },
    });
    expect(await connection.next()).toEqual({
      type: 'error',
      id: 'a',
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
    expect(run).not.toHaveBeenCalled();

    connection.send({ type: 'ping', id: 'p' });
    expect(await connection.next()).toEqual({ type: 'pong', id: 'p' });
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
    for (let i = 0; i < 50 && reports.length === 0; i++) await Bun.sleep(10);
    expect(reports.map((report) => report.source)).toEqual(['websocket']);
  });

  test('refuses the handshake when deps throws, since it runs once per connection there', async () => {
    const { cogitator, run } = fakeCogitator();
    let failing = true;
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      deps: () => {
        if (failing) throw new Error('pool exhausted');
        return { tenant: 'acme' };
      },
    });

    const refused = await connect(request.url).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('handshake refused');
    const res = await request('/ws');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('pool exhausted');
    expect(run).not.toHaveBeenCalled();

    failing = false;
    const connection = await connect(request.url);
    connection.send({ type: 'run', payload: { type: 'agent', name: 'chat', input: 'hi' } });
    await connection.until('complete');
    expect(lastRunOptions(run).deps).toEqual({ tenant: 'acme' });
  });

  test('hands agent runs and resumes the deps built from the handshake, never the frame', async () => {
    const { cogitator, run, resume } = fakeCogitator();
    let built = 0;
    const request = serveSockets({
      cogitator,
      agents: { chat: chatAgent() },
      deps: (ctx) => {
        built += 1;
        return { tenant: ctx.req.headers.get('x-tenant') };
      },
    });
    const connection = await connect(request.url, { 'x-tenant': 'acme' });

    connection.send({
      type: 'run',
      payload: { type: 'agent', name: 'chat', input: 'hi', deps: { tenant: 'evil' } },
    });
    await connection.until('complete');
    connection.send({
      type: 'resume',
      payload: { name: 'chat', threadId: 't-1', deps: { tenant: 'evil' } },
    });
    await connection.until('complete');

    expect(lastRunOptions(run).deps).toEqual({ tenant: 'acme' });
    expect(lastResumeCall(resume).options.deps).toEqual({ tenant: 'acme' });
    expect(built).toBe(1);
  });
});
