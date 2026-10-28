import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerClientError,
  type AppServerClient,
  type TurnCompletedNotification,
} from '../client/generated';
import { APP_SERVER_ERROR_CODES } from '../protocol/errors';
import { SessionHost } from '../host/session-host';
import {
  answer,
  callTools,
  connectClient,
  createTestHost,
  scriptedBackend,
  waitUntil,
} from './helpers';

const deploy = tool({
  name: 'deploy',
  description: 'Deploys',
  parameters: z.object({ target: z.string() }),
  requiresApproval: true,
  execute: async ({ target }) => `deployed ${target}`,
});

const text = (value: string) => [{ type: 'text' as const, text: value }];

async function failure(promise: Promise<unknown>): Promise<AppServerClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppServerClientError) return error;
    throw error;
  }
  throw new Error('Expected an error answer');
}

async function initialize(client: AppServerClient, approvals?: 'request' | 'pause') {
  return client.initialize({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    clientInfo: { name: 'test' },
    ...(approvals && { capabilities: { approvals } }),
  });
}

function completions(client: AppServerClient) {
  const done: TurnCompletedNotification[] = [];
  client.on('turn/completed', (params) => done.push(params));
  return {
    done,
    async of(turnId: string) {
      await waitUntil(() => done.some((n) => n.turn.id === turnId));
      return done.find((n) => n.turn.id === turnId)!.turn;
    },
  };
}

describe('app-server', () => {
  it('answers nothing but initialize before the client initialized, and initialize once', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const { client, connection } = connectClient(host);
    const early = await failure(client.threadList());
    expect(early.code).toBe(APP_SERVER_ERROR_CODES.notInitialized);

    const result = await initialize(client);
    expect(result.protocolVersion).toBe(APP_SERVER_PROTOCOL_VERSION);
    expect(result.agents).toEqual([{ name: 'assistant', model: 'mock/m', default: true }]);
    expect(result.capabilities).toMatchObject({
      approvals: ['request', 'pause'],
      memorySearch: true,
      rewind: true,
      workflows: false,
      swarms: false,
    });
    expect(connection.initialized).toBe(true);
    expect(connection.clientInfo).toEqual({ name: 'test' });

    const again = await failure(initialize(client));
    expect(again.code).toBe(APP_SERVER_ERROR_CODES.alreadyInitialized);
    client.close();
    await host.close();
  });

  it('answers bad params with -32602 and its issues, unknown methods with -32601', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const { client } = connectClient(host);
    await initialize(client);
    const bad = await failure(client.turnStart({ threadId: 7 } as never));
    expect(bad.code).toBe(APP_SERVER_ERROR_CODES.invalidParams);
    expect(bad.data).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['threadId'] })]),
    });
    const noRunner = await failure(client.workflowList());
    expect(noRunner.code).toBe(APP_SERVER_ERROR_CODES.methodNotFound);
    const missing = await failure(client.threadResume({ threadId: 'ghost' }));
    expect(missing.code).toBe(APP_SERVER_ERROR_CODES.notFound);
    expect(missing.data).toEqual({ kind: 'thread', id: 'ghost' });
    client.close();
    await host.close();
  });

  it('answers turn/start before it sends turn/started', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('hello')]).backend });
    const { client, lines } = connectClient(host);
    await initialize(client);
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('hi') });
    expect((await turns.of(turn.id)).output).toBe('hello');

    const fromServer = lines.filter((line) => line.from === 'server').map((line) => line.message);
    const answerAt = fromServer.findIndex(
      (message) =>
        'result' in message &&
        typeof message.result === 'object' &&
        message.result !== null &&
        'turn' in message.result
    );
    const startedAt = fromServer.findIndex((message) => message.method === 'turn/started');
    const firstEventAt = fromServer.findIndex((message) => message.method === 'turn/event');
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeLessThan(startedAt);
    expect(startedAt).toBeLessThan(firstEventAt);
    expect(fromServer.every((message) => message.jsonrpc === '2.0')).toBe(true);
    client.close();
    await host.close();
  });

  it('maps the state of a thread to its error codes', async () => {
    const scripted = scriptedBackend([{ hold: true }]);
    const { host } = createTestHost({ backend: scripted.backend });
    const { client } = connectClient(host);
    await initialize(client);
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('go') });

    const busy = await failure(client.turnStart({ threadId: thread.id, input: text('again') }));
    expect(busy.code).toBe(APP_SERVER_ERROR_CODES.threadBusy);
    const archiving = await failure(client.threadArchive({ threadId: thread.id }));
    expect(archiving.code).toBe(APP_SERVER_ERROR_CODES.threadBusy);
    const wrong = await failure(
      client.turnSteer({ threadId: thread.id, expectedTurnId: 'turn_x', input: text('x') })
    );
    expect(wrong.code).toBe(APP_SERVER_ERROR_CODES.turnNotActive);

    await waitUntil(() => scripted.requests.length === 1);
    expect(await client.turnInterrupt({ threadId: thread.id, turnId: turn.id })).toEqual({
      undelivered: [],
    });
    expect((await turns.of(turn.id)).status).toBe('interrupted');

    await client.threadArchive({ threadId: thread.id });
    const archived = await failure(client.turnStart({ threadId: thread.id, input: text('x') }));
    expect(archived.code).toBe(APP_SERVER_ERROR_CODES.threadArchived);
    client.close();
    await host.close();
  });

  it('answers -32022 for new input to a paused thread', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('done'),
    ]);
    const { host } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const { client } = connectClient(host);
    await initialize(client, 'pause');
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('ship') });
    expect((await turns.of(turn.id)).status).toBe('paused');
    const paused = await failure(client.turnStart({ threadId: thread.id, input: text('hi') }));
    expect(paused.code).toBe(APP_SERVER_ERROR_CODES.threadPaused);
    const resumed = await client.turnStart({
      threadId: thread.id,
      resume: { defaultDecision: { approved: true } },
    });
    expect((await turns.of(resumed.turn.id)).output).toBe('done');
    client.close();
    await host.close();
  });

  it('answers -32030 with the code of the runtime', async () => {
    const backend = scriptedBackend([answer('x')]).backend;
    const host = new SessionHost({
      cogitator: new Cogitator({ llm: { backends: { mock: backend } } }),
      agents: { a: new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }) },
    });
    const { client } = connectClient(host);
    await initialize(client);
    const error = await failure(client.threadStart());
    expect(error.code).toBe(APP_SERVER_ERROR_CODES.runtimeError);
    expect(error.data).toEqual({ code: 'MEMORY_REQUIRED' });
    client.close();
    await host.close();
  });

  it.each([
    ['allow_once', 'completed', 'deployed prod'],
    ['reject_once', 'completed', 'declined'],
  ] as const)('asks approval/request and goes on with %s', async (optionId, status, seen) => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
      (request) => {
        const last = request.messages.at(-1);
        const content = typeof last?.content === 'string' ? last.content : '';
        return answer(content.includes('deployed') ? 'deployed prod' : 'declined');
      },
    ]);
    const { host } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const { client } = connectClient(host);
    await initialize(client, 'request');
    const asked: string[] = [];
    client.onRequest('approval/request', (params) => {
      asked.push(`${params.toolCall.toolName}:${params.options.map((o) => o.optionId).join(',')}`);
      return { outcome: { outcome: 'selected', optionId } };
    });
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('ship') });
    const done = await turns.of(turn.id);
    expect(done.status).toBe(status);
    expect(done.output).toBe(seen);
    expect(asked).toEqual(['deploy:allow_once,allow_always,reject_once']);
    client.close();
    await host.close();
  });

  it('leaves the turn paused for an option it did not offer', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
    ]);
    const { host } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const { client } = connectClient(host);
    await initialize(client, 'request');
    client.onRequest(
      'approval/request',
      () =>
        ({ outcome: { outcome: 'selected', optionId: 'reject_always' } }) as unknown as {
          outcome: { outcome: 'cancelled' };
        }
    );
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('ship') });
    expect((await turns.of(turn.id)).status).toBe('paused');
    client.close();
    await host.close();
  });

  it('leaves the turn paused when the client cancels the approval', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
    ]);
    const { host } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const { client } = connectClient(host);
    await initialize(client, 'request');
    client.onRequest('approval/request', () => ({ outcome: { outcome: 'cancelled' } }));
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('ship') });
    const done = await turns.of(turn.id);
    expect(done.status).toBe('paused');
    expect(done.pending?.approvals[0]?.toolCallId).toBe('c1');
    client.close();
    await host.close();
  });

  it('drops the approval/request of a turn that was interrupted', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
    ]);
    const { host } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const { client, connection } = connectClient(host);
    await initialize(client, 'request');
    let asked = 0;
    client.onRequest('approval/request', () => {
      asked++;
      return new Promise(() => undefined);
    });
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('ship') });
    await waitUntil(() => asked === 1);
    expect(connection.pendingRequests).toBe(1);
    await client.turnInterrupt({ threadId: thread.id, turnId: turn.id });
    expect((await turns.of(turn.id)).status).toBe('interrupted');
    await waitUntil(() => connection.pendingRequests === 0);
    client.close();
    await host.close();
  });

  it('stays uninitialized when initialize fails, and refuses a second one meanwhile', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const { client, lines } = connectClient(host);
    vi.spyOn(host, 'describe').mockRejectedValueOnce(new Error('memory down'));
    const failed = await failure(initialize(client));
    expect(failed.code).toBe(APP_SERVER_ERROR_CODES.internalError);
    expect((await failure(client.threadList())).code).toBe(APP_SERVER_ERROR_CODES.notInitialized);

    const [first, second] = await Promise.allSettled([initialize(client), initialize(client)]);
    expect(first.status).toBe('fulfilled');
    expect(second.status === 'rejected' && second.reason).toMatchObject({
      code: APP_SERVER_ERROR_CODES.alreadyInitialized,
    });
    const fromServer = lines.filter((l) => l.from === 'server').map((l) => l.message);
    const answeredAt = fromServer.findIndex((m) => 'result' in m);
    expect(fromServer.slice(0, answeredAt).some((m) => 'method' in m)).toBe(false);
    client.close();
    await host.close();
  });

  it('refuses a second turn/start that reuses the id of one still being answered', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('once')]).backend });
    const { client, connection, lines } = connectClient(host);
    await initialize(client);
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const request = {
      jsonrpc: '2.0',
      id: 'dup',
      method: 'turn/start',
      params: { threadId: thread.id, input: text('hi') },
    };
    await Promise.all([connection.receive(request), connection.receive(request)]);
    const answers = lines
      .filter((l) => l.from === 'server' && l.message.id === 'dup')
      .map((l) => l.message);
    expect(answers).toHaveLength(2);
    const refused = answers.find((m) => 'error' in m);
    expect(refused).toMatchObject({ error: { code: APP_SERVER_ERROR_CODES.invalidRequest } });
    const accepted = answers.find((m) => 'result' in m) as { result: { turn: { id: string } } };
    expect((await turns.of(accepted.result.turn.id)).status).toBe('completed');
    client.close();
    await host.close();
  });

  it('leaves out the notifications the client opted out of', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const { client, lines } = connectClient(host);
    await client.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'quiet' },
      capabilities: { optOutNotifications: ['thread/log', 'turn/event'] },
    });
    const turns = completions(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('hi') });
    await turns.of(turn.id);
    const methods = lines.filter((l) => l.from === 'server').map((l) => l.message.method);
    expect(methods).toContain('turn/completed');
    expect(methods).not.toContain('thread/log');
    expect(methods).not.toContain('turn/event');
    client.close();
    await host.close();
  });

  it('sends spans only to clients that asked for traces, and answers trace/get', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const tracing = connectClient(host);
    const quiet = connectClient(host);
    const optedOut = connectClient(host);
    await tracing.client.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'tracing' },
      capabilities: { traces: true },
    });
    await quiet.client.initialize({ protocolVersion: 1, clientInfo: { name: 'quiet' } });
    await optedOut.client.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'opted-out' },
      capabilities: { traces: true, optOutNotifications: ['_cogitator/trace/span'] },
    });
    const spans: string[] = [];
    tracing.client.on('_cogitator/trace/span', ({ span }) => spans.push(span.id));
    const turns = completions(tracing.client);
    const { thread } = await tracing.client.threadStart();
    const { turn } = await tracing.client.turnStart({ threadId: thread.id, input: text('hi') });
    await turns.of(turn.id);
    await waitUntil(() => spans.length > 0);

    const trace = await quiet.client.traceGet({ turnId: turn.id });
    expect(trace.threadId).toBe(thread.id);
    expect(trace.spans.map((span) => span.id)).toEqual(spans);
    const methods = (lines: typeof quiet.lines) =>
      lines.filter((l) => l.from === 'server').map((l) => l.message.method);
    expect(methods(quiet.lines)).not.toContain('_cogitator/trace/span');
    expect(methods(optedOut.lines)).not.toContain('_cogitator/trace/span');
    expect(methods(quiet.lines)).toContain('turn/completed');

    const missing = await failure(quiet.client.traceGet({ turnId: 'turn_ghost' }));
    expect(missing.code).toBe(APP_SERVER_ERROR_CODES.notFound);
    expect(missing.data).toEqual({ kind: 'turn', id: 'turn_ghost' });
    for (const connected of [tracing, quiet, optedOut]) connected.client.close();
    await host.close();
  });

  it('runs the extensions the host was given', async () => {
    const { host } = createTestHost({
      backend: scriptedBackend([answer('x')]).backend,
      swarms: {
        list: () => [{ name: 'debate' }],
        run: async (_name, input) => ({ verdict: input }),
      },
    });
    const { client } = connectClient(host);
    await initialize(client);
    expect(await client.swarmList()).toEqual({ items: [{ name: 'debate' }] });
    const run = await client.swarmRun({ name: 'debate', input: 'tabs' });
    expect(run.result).toEqual({ verdict: 'tabs' });
    client.close();
    await host.close();
  });

  it('interrupts the turns of a connection that closes', async () => {
    const scripted = scriptedBackend([{ hold: true }]);
    const { host, notifications } = createTestHost({ backend: scripted.backend });
    const { client, connection } = connectClient(host);
    await initialize(client);
    const { thread } = await client.threadStart();
    const { turn } = await client.turnStart({ threadId: thread.id, input: text('go') });
    await waitUntil(() => scripted.requests.length === 1);
    await connection.close();
    const done = notifications.find(
      (n) => n.method === 'turn/completed' && n.params.turn.id === turn.id
    );
    expect(done).toMatchObject({ params: { turn: { status: 'interrupted' } } });
    expect(connection.closed).toBe(true);
    await host.close();
  });
});
