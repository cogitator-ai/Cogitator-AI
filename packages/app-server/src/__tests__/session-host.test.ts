import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, agentAsTool, tool } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { JsonRpcCallError } from '@cogitator-ai/server-shared';
import { APP_SERVER_ERROR_CODES } from '../protocol/errors';
import { SessionHost } from '../host/session-host';
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
