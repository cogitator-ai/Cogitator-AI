import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, agentAsTool, tool } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { JsonRpcCallError } from '@cogitator-ai/server-shared';
import { APP_SERVER_ERROR_CODES } from '../protocol/errors';
import { SessionHost } from '../host/session-host';
import type { SessionProvider, SessionProviderTurn } from '../host/provider';
import type { AppServerNotification } from '../protocol/types';
import {
  answer,
  callTools,
  completed,
  createTestHost,
  deferred,
  scriptedBackend,
  userTexts,
  waitUntil,
} from './helpers';

const deploy = tool({
  name: 'deploy',
  description: 'Deploys',
  parameters: z.object({ target: z.string() }),
  requiresApproval: true,
  execute: async ({ target }) => `deployed ${target}`,
});

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<JsonRpcCallError> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (error instanceof JsonRpcCallError) return error;
    throw error;
  }
  throw new Error('Expected a rejection');
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

describe('SessionHost', () => {
  it('runs a turn on MockLLMBackend and streams it as notifications', async () => {
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'Hello ' },
      { content: 'there' },
    ]);
    const { host, notifications } = createTestHost({ backend });
    const thread = await host.startThread({});
    expect(thread).toMatchObject({ agent: 'assistant', status: 'idle', archived: false });
    const turn = await host.startTurn({ threadId: thread.id, input: text('Hi') });
    expect(turn.status).toBe('inProgress');
    const done = await completed(notifications, turn.id);
    expect(done).toMatchObject({ status: 'completed', output: 'Hello there' });
    expect(done.usage).toMatchObject({ totalTokens: expect.any(Number), cost: expect.any(Number) });

    const methods = notifications.map((n) => n.method);
    expect(methods[0]).toBe('thread/started');
    const turnEvents = notifications.filter((n) => n.method === 'turn/event');
    expect(methods.indexOf('turn/started')).toBeLessThan(methods.indexOf('turn/event'));
    expect(methods.lastIndexOf('turn/event')).toBeLessThan(methods.indexOf('turn/completed'));
    const types = turnEvents.map((n) => (n.method === 'turn/event' ? n.params.event.type : ''));
    expect(types[0]).toBe('start');
    expect(types).toContain('text-delta');
    expect(types.at(-1)).toBe('finish');

    const resumed = await host.resumeThread(thread.id);
    expect(resumed.thread.status).toBe('idle');
    expect(resumed.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Hello there'],
    ]);
    await host.close();
  });

  it('keeps the history of a thread across turns', async () => {
    const scripted = scriptedBackend([answer('one'), answer('two')]);
    const { host, notifications } = createTestHost({ backend: scripted.backend });
    const thread = await host.startThread({ threadId: 'kept' });
    await completed(
      notifications,
      (await host.startTurn({ threadId: 'kept', input: text('a') })).id
    );
    await completed(
      notifications,
      (await host.startTurn({ threadId: 'kept', input: text('b') })).id
    );
    expect(thread.id).toBe('kept');
    expect(userTexts(scripted.requests.at(-1))).toEqual(['a', 'b']);
    await expect(host.startThread({ threadId: 'kept' })).rejects.toMatchObject({
      code: APP_SERVER_ERROR_CODES.invalidParams,
    });
    await host.close();
  });

  it('refuses a second turn while one goes on, and steers the one going on', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'look', arguments: {} }]),
      answer('done'),
    ]);
    const gate = deferred();
    const look = tool({
      name: 'look',
      description: 'Looks',
      parameters: z.object({}),
      execute: async () => {
        await gate.promise;
        return 'seen';
      },
    });
    const { host, notifications } = createTestHost({ backend: scripted.backend, tools: [look] });
    const thread = await host.startThread({});
    const turn = await host.startTurn({ threadId: thread.id, input: text('go') });
    await waitUntil(() => scripted.requests.length === 1);

    const busy = await rejection(host.startTurn({ threadId: thread.id, input: text('again') }));
    expect(busy.code).toBe(APP_SERVER_ERROR_CODES.threadBusy);
    expect(busy.data).toEqual({ threadId: thread.id, activeTurnId: turn.id });

    const wrong = await rejection(() =>
      host.steerTurn({ threadId: thread.id, expectedTurnId: 'turn_other', input: text('x') })
    );
    expect(wrong.code).toBe(APP_SERVER_ERROR_CODES.turnNotActive);
    expect(wrong.data).toEqual({ threadId: thread.id, activeTurnId: turn.id });

    expect(
      host.steerTurn({ threadId: thread.id, expectedTurnId: turn.id, input: text('use staging') })
    ).toEqual({ turnId: turn.id });
    expect((await host.resumeThread(thread.id)).thread).toMatchObject({
      status: 'running',
      activeTurnId: turn.id,
    });
    gate.resolve();
    expect(await completed(notifications, turn.id)).toMatchObject({ status: 'completed' });
    expect(userTexts(scripted.requests.at(-1))).toContain('use staging');
    await host.close();
  });

  it('interrupts a turn and hands back what it did not take', async () => {
    const scripted = scriptedBackend([{ hold: true, first: 'Thinking' }]);
    const { host, notifications } = createTestHost({ backend: scripted.backend });
    const thread = await host.startThread({});
    const turn = await host.startTurn({ threadId: thread.id, input: text('long') });
    await waitUntil(() => scripted.requests.length === 1);
    host.steerTurn({
      threadId: thread.id,
      expectedTurnId: turn.id,
      input: text('later'),
      delivery: 'followUp',
    });
    const { undelivered } = host.interruptTurn(thread.id, turn.id);
    expect(undelivered).toEqual([{ delivery: 'followUp', input: text('later') }]);
    const done = await completed(notifications, turn.id);
    expect(done.status).toBe('interrupted');
    expect(done.undelivered).toEqual(undelivered);
    const errorEvent = notifications.find(
      (n) => n.method === 'turn/event' && n.params.event.type === 'error'
    );
    expect(errorEvent).toMatchObject({ params: { event: { code: 'INTERRUPTED' } } });
    expect((await host.resumeThread(thread.id)).thread.status).toBe('idle');
    const late = await rejection(() => host.interruptTurn(thread.id, turn.id));
    expect(late.code).toBe(APP_SERVER_ERROR_CODES.turnNotActive);
    await host.close();
  });

  it('pauses on an approval, refuses new input, and resumes with a decision', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
      answer('shipped'),
    ]);
    const { host, notifications } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const thread = await host.startThread({});
    const turn = await host.startTurn({ threadId: thread.id, input: text('release') });
    const paused = await completed(notifications, turn.id);
    expect(paused.status).toBe('paused');
    expect(paused.pending?.approvals).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        toolName: 'deploy',
        arguments: { target: 'prod' },
      }),
    ]);
    const resumedThread = await host.resumeThread(thread.id);
    expect(resumedThread.thread.status).toBe('paused');
    expect(resumedThread.pending?.interrupts).toEqual([
      expect.objectContaining({ id: 'c1', kind: 'approval', toolCallId: 'c1' }),
    ]);

    const refused = await rejection(host.startTurn({ threadId: thread.id, input: text('hi') }));
    expect(refused.code).toBe(APP_SERVER_ERROR_CODES.threadPaused);

    const resumed = await host.startTurn({
      threadId: thread.id,
      resume: { decisions: { c1: { approved: true } } },
    });
    expect(await completed(notifications, resumed.id)).toMatchObject({
      status: 'completed',
      output: 'shipped',
    });
    const nothing = await rejection(
      host.startTurn({ threadId: thread.id, resume: { defaultDecision: { approved: true } } })
    );
    expect(nothing.code).toBe(APP_SERVER_ERROR_CODES.invalidParams);
    await host.close();
  });

  it('asks the approver while the turn waits', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'eu' } }]),
      answer('ok'),
    ]);
    const { host, notifications } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const thread = await host.startThread({});
    const asked: string[] = [];
    const turn = await host.startTurn(
      { threadId: thread.id, input: text('go') },
      {
        onApproval: async ({ request, turnId }) => {
          asked.push(`${turnId}:${request.toolName}`);
          return { approved: true };
        },
      }
    );
    expect(await completed(notifications, turn.id)).toMatchObject({ status: 'completed' });
    expect(asked).toEqual([`${turn.id}:deploy`]);
    await host.close();
  });

  it('archives, lists and unarchives threads', async () => {
    const { host, notifications } = createTestHost({
      backend: scriptedBackend([answer('x')]).backend,
    });
    const kept = await host.startThread({});
    const old = await host.startThread({});
    const archived = await host.archiveThread(old.id, true);
    expect(archived.archived).toBe(true);
    expect(notifications).toContainEqual({
      method: 'thread/archived',
      params: { threadId: old.id },
    });
    const refused = await rejection(host.startTurn({ threadId: old.id, input: text('x') }));
    expect(refused.code).toBe(APP_SERVER_ERROR_CODES.threadArchived);

    const live = await host.listThreads({ archived: false });
    expect(live.threads.map((t) => t.id)).toEqual([kept.id]);
    const gone = await host.listThreads({ archived: true });
    expect(gone.threads.map((t) => t.id)).toEqual([old.id]);
    expect((await host.listThreads({ agent: 'nobody' })).threads).toEqual([]);

    await host.archiveThread(old.id, false);
    expect((await host.listThreads({ archived: false })).threads).toHaveLength(2);
    await host.close();
  });

  it('forks a thread with its history', async () => {
    const scripted = scriptedBackend([answer('first'), answer('second')]);
    const { host, notifications } = createTestHost({ backend: scripted.backend });
    const thread = await host.startThread({ permissionMode: 'acceptEdits' });
    await completed(
      notifications,
      (await host.startTurn({ threadId: thread.id, input: text('q') })).id
    );
    const fork = await host.forkThread({ threadId: thread.id, newThreadId: 'fork-1' });
    expect(fork).toMatchObject({
      id: 'fork-1',
      forkedFrom: thread.id,
      agent: 'assistant',
      permissionMode: 'acceptEdits',
    });
    expect((await host.resumeThread('fork-1')).messages.map((m) => m.text)).toEqual(['q', 'first']);
    const missing = await rejection(host.forkThread({ threadId: thread.id, atEntryId: 'nope' }));
    expect(missing.code).toBe(APP_SERVER_ERROR_CODES.notFound);
    expect(missing.data).toEqual({ kind: 'entry', id: 'nope' });
    await host.close();
  });

  it('answers with structured output for an output schema', async () => {
    const scripted = scriptedBackend([answer('{"city":"Paris"}')]);
    const { host, notifications } = createTestHost({ backend: scripted.backend });
    const thread = await host.startThread({});
    const turn = await host.startTurn({
      threadId: thread.id,
      input: text('where'),
      outputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    });
    expect((await completed(notifications, turn.id)).structured).toEqual({ city: 'Paris' });
    await host.close();
  });

  it('reviews changes into a review thread of their own', async () => {
    const review = {
      findings: [
        {
          title: 'Off by one',
          body: 'The loop skips the last item.',
          priority: 1,
          confidence: 0.8,
          location: { path: 'src/a.ts', startLine: 3, endLine: 4 },
        },
      ],
      overallCorrectness: 'incorrect',
      overallExplanation: 'One bug.',
    };
    const scripted = scriptedBackend([answer(JSON.stringify(review))]);
    const read: string[] = [];
    const { host, notifications } = createTestHost({
      backend: scripted.backend,
      review: {
        context: async (target) => {
          read.push(target.type);
          return 'diff --git a/src/a.ts b/src/a.ts';
        },
      },
    });
    const thread = await host.startThread({});
    const started = await host.startReview({
      threadId: thread.id,
      target: { type: 'commit', sha: 'abc123', title: 'Fix loop' },
    });
    expect(started.reviewThreadId).toMatch(/^review_/);
    expect(started.turn.threadId).toBe(started.reviewThreadId);
    const done = await completed(notifications, started.turn.id);
    expect(done.review).toEqual(review);
    expect(read).toEqual(['commit']);
    const prompt = userTexts(scripted.requests[0]).join('\n');
    expect(prompt).toContain('Review commit abc123 (Fix loop)');
    expect(prompt).toContain('diff --git');
    expect(scripted.requests[0]?.responseFormat).toMatchObject({ type: 'json_schema' });
    const reviewThread = (await host.resumeThread(started.reviewThreadId)).thread;
    expect(reviewThread.metadata).toMatchObject({ reviewOf: thread.id });
    await host.close();
  });

  it('resumes a paused review as a review', async () => {
    const review = { findings: [], overallCorrectness: 'correct', overallExplanation: 'Fine.' };
    const scripted = scriptedBackend([
      callTools([{ id: 'r1', name: 'deploy', arguments: { target: 'staging' } }]),
      answer(JSON.stringify(review)),
    ]);
    const { host, notifications } = createTestHost({
      backend: scripted.backend,
      tools: [deploy],
      review: { context: async () => 'diff --git a/x b/x' },
    });
    const thread = await host.startThread({});
    const started = await host.startReview({
      threadId: thread.id,
      target: { type: 'uncommittedChanges' },
      model: 'mock/review',
    });
    expect((await completed(notifications, started.turn.id)).status).toBe('paused');
    const refused = await rejection(
      host.startTurn({
        threadId: started.reviewThreadId,
        resume: { defaultDecision: { approved: true } },
        outputSchema: { type: 'object' },
      })
    );
    expect(refused.code).toBe(APP_SERVER_ERROR_CODES.invalidParams);
    const resumed = await host.startTurn({
      threadId: started.reviewThreadId,
      resume: { defaultDecision: { approved: true } },
    });
    const done = await completed(notifications, resumed.id);
    expect(done.status).toBe('completed');
    expect(done.review).toEqual(review);
    const last = scripted.requests.at(-1);
    expect(last?.responseFormat).toMatchObject({ type: 'json_schema' });
    expect(last?.model).toBe('review');
    expect(String(last?.messages[0]?.content)).toContain('You review code changes');
    await host.close();
  });

  it('tags the events of delegated runs with the tool call that started them', async () => {
    const lead = scriptedBackend([
      callTools([{ id: 'p1', name: 'researcher', arguments: { task: 'find it' } }]),
      answer('summary'),
    ]);
    const child = scriptedBackend([answer('found it')]);
    const cogitator = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { lead: lead.backend, child: child.backend } },
    });
    const researcher = new Agent({ name: 'researcher', model: 'child/m', instructions: 'Find.' });
    const agent = new Agent({
      name: 'lead',
      model: 'lead/m',
      instructions: 'Lead.',
      tools: [agentAsTool(cogitator, researcher, { name: 'researcher', description: 'Finds' })],
    });
    const host = new SessionHost({ cogitator, agents: { lead: agent } });
    const events: Array<{ type: string; parent?: string; agent?: string }> = [];
    host.subscribe((n) => {
      if (n.method === 'turn/event') {
        events.push({
          type: n.params.event.type,
          ...(n.params.parentToolCallId !== undefined && { parent: n.params.parentToolCallId }),
          ...(n.params.agent !== undefined && { agent: n.params.agent }),
        });
      }
    });
    const turnIds: string[] = [];
    host.subscribe((n) => {
      if (n.method === 'turn/completed') turnIds.push(n.params.turn.id);
    });
    const thread = await host.startThread({});
    const turn = await host.startTurn({ threadId: thread.id, input: text('research') });
    await waitUntil(() => turnIds.includes(turn.id));
    const delegated = events.filter((event) => event.parent === 'p1');
    expect(delegated.map((event) => event.type)).toContain('text-delta');
    expect(delegated[0]).toEqual({ type: 'start', parent: 'p1', agent: 'researcher' });
    expect(delegated.at(-1)?.type).toBe('finish');
    expect(events.filter((event) => event.parent === undefined).at(-1)?.type).toBe('finish');
    await host.close();
    await cogitator.close();
  });

  it('reports memory changes as thread/log', async () => {
    const { host, notifications } = createTestHost({
      backend: scriptedBackend([answer('hey')]).backend,
    });
    await host.ready();
    const thread = await host.startThread({});
    await completed(
      notifications,
      (await host.startTurn({ threadId: thread.id, input: text('yo') })).id
    );
    const logged = notifications.filter((n) => n.method === 'thread/log');
    expect(logged.length).toBeGreaterThanOrEqual(2);
    expect(logged[0]).toMatchObject({
      params: { threadId: thread.id, change: 'entry-added', entry: { role: 'user', text: 'yo' } },
    });
    await host.close();
  });

  it('searches the turns of a thread', async () => {
    const { host, notifications } = createTestHost({
      backend: scriptedBackend([answer('Your parrot is named Kiwi.')]).backend,
    });
    const thread = await host.startThread({});
    await completed(
      notifications,
      (await host.startTurn({ threadId: thread.id, input: text('My parrot is named Kiwi') })).id
    );
    const found = await host.searchMemory({ query: 'parrot Kiwi', threadId: thread.id });
    expect(found.results.some((hit) => hit.kind === 'turn')).toBe(true);
    await host.close();
  });

  it('rewinds a thread to an entry', async () => {
    const { host, notifications } = createTestHost({
      backend: scriptedBackend([answer('one'), answer('two')]).backend,
    });
    const thread = await host.startThread({});
    await completed(
      notifications,
      (await host.startTurn({ threadId: thread.id, input: text('a') })).id
    );
    const [first] = (await host.resumeThread(thread.id)).messages;
    await completed(
      notifications,
      (await host.startTurn({ threadId: thread.id, input: text('b') })).id
    );
    const report = await host.rewindThread({ threadId: thread.id, toEntryId: first!.entryId });
    expect(report.conversation.rewound).toBe(true);
    expect(report.conversation.cut.length).toBeGreaterThan(0);
    expect((await host.resumeThread(thread.id)).messages.map((m) => m.text)).toEqual(['a']);
    await host.close();
  });

  it('sets the permission mode of a thread for its next turns', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const thread = await host.startThread({});
    expect((await host.setPermissionMode(thread.id, 'plan')).permissionMode).toBe('plan');
    expect((await host.resumeThread(thread.id)).thread.permissionMode).toBe('plan');
    await host.close();
  });

  it('runs workflows by name and streams their events', async () => {
    const { host, notifications } = createTestHost({
      backend: scriptedBackend([answer('x')]).backend,
      workflows: {
        list: () => [{ name: 'digest', description: 'Daily digest' }],
        run: async (name, input, context) => {
          context.emit({ step: 'one' });
          return { name, input };
        },
      },
    });
    const run = await host.run('workflow', 'digest', { day: 'mon' });
    expect(run.result).toEqual({ name: 'digest', input: { day: 'mon' } });
    expect(notifications).toContainEqual({
      method: '_cogitator/workflow/event',
      params: { runId: run.runId, name: 'digest', event: { step: 'one' } },
    });
    const missing = await rejection(host.run('workflow', 'nope', undefined));
    expect(missing.data).toEqual({ kind: 'workflow', id: 'nope' });
    expect((await rejection(host.run('swarm', 'x', undefined))).data).toEqual({
      kind: 'swarm',
      id: 'x',
    });
    await host.close();
  });

  it('keeps the spans of each turn and sends them as they end', async () => {
    const { host, notifications } = createTestHost({
      backend: scriptedBackend([answer('traced')]).backend,
    });
    const thread = await host.startThread({});
    const turn = await host.startTurn({ threadId: thread.id, input: text('trace me') });
    await completed(notifications, turn.id);
    const sent = notifications.flatMap((n) =>
      n.method === '_cogitator/trace/span' ? [n.params] : []
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((n) => n.threadId === thread.id && n.turnId === turn.id)).toBe(true);
    const trace = host.getTrace(turn.id);
    expect(trace).toMatchObject({ threadId: thread.id, turnId: turn.id });
    expect(trace.spans.map((span) => span.id)).toEqual(sent.map((n) => n.span.id));
    expect(trace.spans[0]).toMatchObject({
      traceId: expect.any(String),
      name: expect.any(String),
      startTime: expect.any(Number),
    });
    expect((await host.describe()).capabilities.traces).toBe(true);
    const missing = await rejection(() => host.getTrace('turn_ghost'));
    expect(missing.data).toEqual({ kind: 'turn', id: 'turn_ghost' });
    await host.close();
  });

  it('aborts the signal of an approval being asked once the turn is interrupted', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }]),
    ]);
    const { host, notifications } = createTestHost({ backend: scripted.backend, tools: [deploy] });
    const thread = await host.startThread({});
    let asked: AbortSignal | undefined;
    const turn = await host.startTurn(
      { threadId: thread.id, input: text('ship') },
      {
        onApproval: ({ signal }) => {
          asked = signal;
          return new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve('pause'), { once: true })
          );
        },
      }
    );
    await waitUntil(() => asked !== undefined);
    expect(asked?.aborted).toBe(false);
    host.interruptTurn(thread.id, turn.id);
    expect(asked?.aborted).toBe(true);
    expect((await completed(notifications, turn.id)).status).toBe('interrupted');
    await host.close();
  });

  it('tries the memory again after it failed to connect', async () => {
    const { host, cogitator } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    vi.spyOn(cogitator, 'getMemory').mockRejectedValueOnce(new Error('down'));
    await expect(host.ready()).rejects.toThrow('down');
    await expect(host.ready()).resolves.toBeUndefined();
    expect((await host.startThread({})).status).toBe('idle');
    await host.close();
  });

  it('keeps the details of internal errors from clients unless exposeErrors', async () => {
    const { host, cogitator } = createTestHost({
      backend: scriptedBackend([answer('x')]).backend,
      exposeErrors: false,
      review: {
        context: async () => {
          throw new Error('fatal: /home/secret/repo is not a repository');
        },
      },
    });
    const thread = await host.startThread({});
    const memory = await cogitator.getMemory();
    vi.spyOn(memory!, 'getThread').mockResolvedValueOnce({
      success: false,
      error: 'connection to postgres://admin:hunter2@db failed',
    });
    const memoryError = await rejection(host.resumeThread(thread.id));
    expect(memoryError.message).toBe('The memory store failed');
    expect(JSON.stringify(memoryError.toJSON())).not.toContain('hunter2');
    expect(memoryError.data).toEqual({ code: 'MEMORY_ERROR' });

    const reviewError = await rejection(
      host.startReview({ threadId: thread.id, target: { type: 'uncommittedChanges' } })
    );
    expect(reviewError.message).toBe('Reading the changes to review failed');
    expect(reviewError.message).not.toContain('secret');

    vi.spyOn(cogitator, 'invokeTool').mockResolvedValueOnce({
      callId: 'c',
      name: 'search_memory',
      result: null,
      error: 'index at /var/secret broke',
    } as Awaited<ReturnType<typeof cogitator.invokeTool>>);
    const searchError = await rejection(host.searchMemory({ query: 'x', threadId: thread.id }));
    expect(searchError.message).toBe('Memory search failed');
    await host.close();
  });

  it('hands back the messages queued for a turn whose run could not start', async () => {
    const { host, cogitator, notifications } = createTestHost({
      backend: scriptedBackend([answer('x')]).backend,
    });
    const thread = await host.startThread({});
    let release = () => undefined as void;
    const after = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = await host.startTurn({ threadId: thread.id, input: text('go') }, { after });
    host.steerTurn({ threadId: thread.id, expectedTurnId: turn.id, input: text('and this') });
    vi.spyOn(cogitator, 'start').mockImplementationOnce(() => {
      throw new Error('cannot start');
    });
    release();
    const done = await completed(notifications, turn.id);
    expect(done.status).toBe('failed');
    expect(done.undelivered).toEqual([{ delivery: 'steer', input: text('and this') }]);
    await host.close();
  });

  it('creates a thread once when two starts name the same id at once', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    const results = await Promise.allSettled([
      host.startThread({ threadId: 'same', metadata: { from: 'a' } }),
      host.startThread({ threadId: 'same', metadata: { from: 'b' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject({
      code: APP_SERVER_ERROR_CODES.invalidParams,
    });
    const kept = (await host.resumeThread('same')).thread.metadata.from;
    const won = results.find((r) => r.status === 'fulfilled');
    expect(won?.status === 'fulfilled' && won.value.metadata.from).toBe(kept);
    await host.startThread({ threadId: 'free-again' });
    await host.close();
  });

  it('drops a review whose host closed while it read its changes', async () => {
    const scripted = scriptedBackend([answer('{}')]);
    const gate = deferred();
    const { host, notifications } = createTestHost({
      backend: scripted.backend,
      review: {
        context: async () => {
          await gate.promise;
          return 'diff';
        },
      },
    });
    const thread = await host.startThread({});
    const review = host.startReview({
      threadId: thread.id,
      target: { type: 'uncommittedChanges' },
    });
    const closed = host.close();
    gate.resolve();
    const error = await rejection(review);
    expect(error.data).toEqual({ code: 'CANCELLED' });
    await closed;
    expect(notifications.some((n) => n.method === 'turn/started')).toBe(false);
    expect(scripted.requests).toHaveLength(0);
  });

  it('keeps the configured id of the agent for turn overrides and reviews', async () => {
    const scripted = scriptedBackend([
      answer('{"a":1}'),
      answer('x'),
      answer('{"findings":[],"overallCorrectness":"correct","overallExplanation":"ok"}'),
    ]);
    const cogitator = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: scripted.backend } },
    });
    const agent = new Agent({ id: 'keeper', name: 'Keeper', model: 'mock/m', instructions: 'x' });
    const host = new SessionHost({
      cogitator,
      agents: { keeper: agent },
      review: { context: async () => 'diff' },
    });
    const ids: Array<string | undefined> = [];
    const start = cogitator.start.bind(cogitator);
    vi.spyOn(cogitator, 'start').mockImplementation((used, options) => {
      ids.push(used.config.id);
      return start(used, options);
    });
    const turnIds: string[] = [];
    host.subscribe((n) => {
      if (n.method === 'turn/completed') turnIds.push(n.params.turn.id);
    });
    const thread = await host.startThread({});
    const withSchema = await host.startTurn({
      threadId: thread.id,
      input: text('a'),
      outputSchema: { type: 'object', properties: { a: { type: 'number' } } },
    });
    await waitUntil(() => turnIds.includes(withSchema.id));
    const withModel = await host.startTurn({
      threadId: thread.id,
      input: text('b'),
      model: 'mock/other',
    });
    await waitUntil(() => turnIds.includes(withModel.id));
    const review = await host.startReview({
      threadId: thread.id,
      target: { type: 'custom', instructions: 'x' },
    });
    await waitUntil(() => turnIds.includes(review.turn.id));
    expect(ids).toEqual(['keeper', 'keeper', 'keeper']);
    await host.close();
    await cogitator.close();
  });

  it('reviews in the permission mode of the thread it reviews, resumed too', async () => {
    const scripted = scriptedBackend([
      answer('{"findings":[],"overallCorrectness":"correct","overallExplanation":"ok"}'),
    ]);
    const { host, cogitator, notifications } = createTestHost({
      backend: scripted.backend,
      review: { context: async () => 'diff' },
    });
    const modes: Array<string | undefined> = [];
    const start = cogitator.start.bind(cogitator);
    vi.spyOn(cogitator, 'start').mockImplementation((agent, options) => {
      modes.push(options.permissions?.mode);
      return start(agent, options);
    });
    const thread = await host.startThread({ permissionMode: 'plan' });
    const review = await host.startReview({
      threadId: thread.id,
      target: { type: 'custom', instructions: 'x' },
    });
    await completed(notifications, review.turn.id);
    expect(modes).toEqual(['plan']);
    const reviewThread = (await host.resumeThread(review.reviewThreadId)).thread;
    expect(reviewThread.permissionMode).toBe('plan');
    await host.close();
  });

  it('starts a turn in the permission mode set before its run began', async () => {
    const { host, cogitator, notifications } = createTestHost({
      backend: scriptedBackend([answer('x')]).backend,
    });
    const thread = await host.startThread({ permissionMode: 'default' });
    const modes: Array<string | undefined> = [];
    const start = cogitator.start.bind(cogitator);
    vi.spyOn(cogitator, 'start').mockImplementation((agent, options) => {
      modes.push(options.permissions?.mode);
      return start(agent, options);
    });
    let release = () => undefined as void;
    const after = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = await host.startTurn({ threadId: thread.id, input: text('go') }, { after });
    await host.setPermissionMode(thread.id, 'plan');
    release();
    await completed(notifications, turn.id);
    expect(modes).toEqual(['plan']);
    await host.close();
  });

  it('names what does not exist', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('x')]).backend });
    expect((await rejection(host.resumeThread('ghost'))).data).toEqual({
      kind: 'thread',
      id: 'ghost',
    });
    expect((await rejection(host.startThread({ agent: 'ghost' }))).data).toEqual({
      kind: 'agent',
      id: 'ghost',
    });
    expect(() => new SessionHost({ cogitator: new Cogitator(), agents: {} })).toThrow(/agent/);
    await host.close();
  });

  it('needs memory to keep threads', async () => {
    const backend = scriptedBackend([answer('x')]).backend;
    const cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
    const host = new SessionHost({
      cogitator,
      agents: { a: new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }) },
    });
    const error = await rejection(host.startThread({}));
    expect(error.code).toBe(APP_SERVER_ERROR_CODES.runtimeError);
    expect(error.data).toEqual({ code: 'MEMORY_REQUIRED' });
    expect((await host.describe()).capabilities).toMatchObject({
      memorySearch: false,
      rewind: false,
    });
    await host.close();
  });
});

describe('SessionHost with providers', () => {
  function providerHost(provider: SessionProvider) {
    const host = new SessionHost({
      cogitator: new Cogitator({ memory: { adapter: 'memory' } }),
      agents: { assistant: new Agent({ name: 'assistant', model: 'mock/m', instructions: 'x' }) },
      providers: { outside: provider },
      exposeErrors: true,
    });
    const notifications: AppServerNotification[] = [];
    host.subscribe((notification) => notifications.push(notification));
    return { host, notifications };
  }

  it('runs a turn of a provider, keeps its messages and its metadata', async () => {
    const seen: SessionProviderTurn[] = [];
    const startModes: string[] = [];
    const provider: SessionProvider = {
      description: 'Outside',
      model: 'x/y',
      runTurn: async (turn) => {
        seen.push(turn);
        turn.emit({ type: 'text-start', id: 't' });
        turn.emit({ type: 'text-delta', id: 't', delta: 'hi' });
        turn.emit({ type: 'text-end', id: 't' });
        await turn.saveMetadata({ session: 's1' });
        startModes.push(turn.permissionMode());
        await turn.setPermissionMode('acceptEdits');
        return { output: 'hi', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
      },
    };
    const { host, notifications } = providerHost(provider);
    expect(host.agents()).toEqual([
      { name: 'assistant', model: 'mock/m', default: true },
      { name: 'outside', description: 'Outside', model: 'x/y', default: false, external: true },
    ]);
    const thread = await host.startThread({ agent: 'outside', permissionMode: 'plan' });
    const turn = await host.startTurn({ threadId: thread.id, input: text('hello'), model: 'x/z' });
    const done = await completed(notifications, turn.id);
    expect(done).toMatchObject({
      status: 'completed',
      output: 'hi',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(seen[0]).toMatchObject({ threadId: thread.id, model: 'x/z', input: text('hello') });
    expect(startModes).toEqual(['plan']);
    const types = notifications.flatMap((n) =>
      n.method === 'turn/event' && n.params.turnId === turn.id ? [n.params.event.type] : []
    );
    expect(types).toEqual(['start', 'text-start', 'text-delta', 'text-end', 'finish']);
    const resumed = await host.resumeThread(thread.id);
    expect(resumed.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi'],
    ]);
    expect(resumed.thread.metadata.session).toBe('s1');
    expect(resumed.thread.permissionMode).toBe('acceptEdits');
    expect(seen[0]!.permissionMode()).toBe('acceptEdits');
    await host.close();
  });

  it('fails the turn of a provider that throws and refuses what needs the runtime', async () => {
    const provider: SessionProvider = {
      runTurn: async () => {
        throw new Error('agent crashed');
      },
    };
    const { host, notifications } = providerHost(provider);
    const thread = await host.startThread({ agent: 'outside' });
    const turn = await host.startTurn({ threadId: thread.id, input: text('x') });
    expect(await completed(notifications, turn.id)).toMatchObject({
      status: 'failed',
      error: { message: 'agent crashed' },
    });
    expect(
      (await rejection(host.startTurn({ threadId: thread.id, input: text('x'), outputSchema: {} })))
        .code
    ).toBe(APP_SERVER_ERROR_CODES.invalidParams);
    expect((await rejection(host.forkThread({ threadId: thread.id }))).message).toMatch(
      /outside the runtime/
    );
    expect((await rejection(host.searchMemory({ query: 'x', agent: 'outside' }))).message).toMatch(
      /outside the runtime/
    );
    await host.close();
  });

  it('changes the mode of a provider turn going on and interrupts it', async () => {
    let release: (() => void) | undefined;
    const modes: string[] = [];
    const provider: SessionProvider = {
      runTurn: (turn) =>
        new Promise((resolve, reject) => {
          release = () => {
            modes.push(turn.permissionMode());
            resolve({ output: 'late' });
          };
          turn.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
    const { host, notifications } = providerHost(provider);
    const thread = await host.startThread({ agent: 'outside' });
    const first = await host.startTurn({ threadId: thread.id, input: text('x') });
    await waitUntil(() => release !== undefined);
    await host.setPermissionMode(thread.id, 'acceptEdits');
    release!();
    await completed(notifications, first.id);
    expect(modes).toEqual(['acceptEdits']);
    release = undefined;
    const second = await host.startTurn({ threadId: thread.id, input: text('y') });
    await waitUntil(() => release !== undefined);
    host.interruptTurn(thread.id, second.id);
    expect((await completed(notifications, second.id)).status).toBe('interrupted');
    await host.close();
  });

  it('deletes a thread and merges metadata without the host keys', async () => {
    const backend = new MockLLMBackend();
    const { host } = createTestHost({ backend });
    const thread = await host.startThread({});
    const updated = await host.updateThread(thread.id, { title: 'T', agent: 'nope' });
    expect(updated.metadata).toMatchObject({ title: 'T', agent: 'assistant' });
    await host.deleteThread(thread.id);
    expect((await rejection(host.getThread(thread.id))).code).toBe(APP_SERVER_ERROR_CODES.notFound);
    await host.close();
  });

  it('refuses a provider named like an agent', () => {
    expect(
      () =>
        new SessionHost({
          cogitator: new Cogitator({ memory: { adapter: 'memory' } }),
          agents: { a: new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }) },
          providers: { a: { runTurn: async () => ({ output: '' }) } },
        })
    ).toThrow(/both an agent and a provider/);
  });
});
