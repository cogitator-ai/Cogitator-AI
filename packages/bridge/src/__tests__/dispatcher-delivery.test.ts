import { afterEach, describe, expect, it } from 'vitest';
import type { CreatedSession, LetterDelivery } from '../adapter';
import { BridgeDispatcher } from '../dispatcher';
import { FakeAdapter, makeKit, MINUTE, type Kit } from './bridge-kit';

let kit: Kit;

afterEach(async () => {
  await kit.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('delivery through an adapter', () => {
  it('hands the letter over with its signature and marks it delivered', async () => {
    const adapter = new FakeAdapter();
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex } = kit;

    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    await bridge.idle();

    expect(adapter.delivered).toHaveLength(1);
    expect(adapter.delivered[0]).toMatchObject({
      agent: { name: 'codex@demo', sessionId: 'thread-codex' },
      job: { number: 1, state: 'submitted' },
      letter: { id: 'ltr_1', kind: 'task' },
    });
    expect(adapter.texts[0]).toBe(
      '[agent bridge] job #1 "Write the tests" | task from claude@demo to codex@demo | letter ltr_1 | not typed by the user\nWrite the tests'
    );
    const [letter] = await bridge.letters({ job: 1 });
    expect(letter).toMatchObject({ state: 'delivered', attempts: 0 });
    expect(letter.deliveredAt).toBeDefined();
    expect((await bridge.readJournal({ job: 1 })).map((entry) => entry.type)).toContain(
      'letter.delivered'
    );
    expect(letter.replyDueAt).toBeUndefined();
    expect((await bridge.job(1)).state).toBe('working');

    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'On it' });
    expect((await bridge.letters({ job: 1, kinds: ['task'] }))[0].state).toBe('read');
    expect(kit.errors).toEqual([]);
  });

  it('counts a job the harness took as taken: a session that works in silence is not failed', async () => {
    const adapter = new FakeAdapter();
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Write the tests',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    await bridge.idle();

    clock.advance(30 * MINUTE);
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });
    expect((await bridge.job(1)).state).toBe('working');

    const { job } = await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    expect(job.state).toBe('completed');
  });

  it('still reminds of a question that was delivered and not answered', async () => {
    const adapter = new FakeAdapter();
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Write the tests',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    const { letter } = await bridge.send(claude.name, {
      job: 1,
      kind: 'question',
      body: 'How far?',
    });
    await bridge.idle();

    clock.advance(5 * MINUTE);
    expect((await bridge.sweep()).reminded).toEqual([letter.id]);
  });

  it('leaves the mail of a harness without an adapter in its inbox', async () => {
    const adapter = new FakeAdapter();
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.send(codex.name, { job: 1, kind: 'question', body: 'Which?' });
    await bridge.idle();

    expect(adapter.delivered.map((delivery) => delivery.agent.name)).toEqual(['codex@demo']);
    expect(await bridge.inbox(claude.name)).toMatchObject([{ kind: 'question', state: 'read' }]);
  });

  it('does not push through an adapter that cannot wake a session', async () => {
    const adapter = new FakeAdapter({ capabilities: { push: false } });
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.createJob(kit.claude.name, { to: 'codex', body: 'Do it' });
    await kit.bridge.idle();

    expect(adapter.delivered).toEqual([]);
    expect(await kit.bridge.inbox(kit.codex.name)).toHaveLength(1);
  });

  it('keeps the order letters were sent in, however long each delivery takes', async () => {
    const waits = [30, 1, 10];
    const adapter = new FakeAdapter({
      deliver: () => new Promise((resolve) => setTimeout(resolve, waits.shift() ?? 0)),
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;

    await bridge.createJob(claude.name, { to: 'codex', body: 'First' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Second' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Third' });
    await bridge.idle();

    expect(adapter.delivered.map((delivery) => delivery.letter.body)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it('tries again later when the harness could not take the letter', async () => {
    let failures = 2;
    const adapter = new FakeAdapter({
      deliver: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('codex queue: thread is busy');
        }
      },
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.idle();

    let [letter] = await bridge.letters({ job: 1 });
    expect(letter).toMatchObject({
      state: 'queued',
      attempts: 1,
      lastError: 'codex queue: thread is busy',
    });
    expect(Date.parse(letter.nextAttemptAt!)).toBe(clock.now() + 2_000);

    clock.advance(1_999);
    await bridge.sweep();
    await bridge.idle();
    expect((await bridge.letters({ job: 1 }))[0].attempts).toBe(1);

    clock.advance(1);
    await bridge.sweep();
    await bridge.idle();
    [letter] = await bridge.letters({ job: 1 });
    expect(letter.attempts).toBe(2);
    expect(Date.parse(letter.nextAttemptAt!)).toBe(clock.now() + 4_000);

    clock.advance(4_000);
    await bridge.sweep();
    await bridge.idle();
    [letter] = await bridge.letters({ job: 1 });
    expect(letter).toMatchObject({ state: 'delivered', attempts: 2 });
    expect(letter.lastError).toBeUndefined();
    expect(letter.nextAttemptAt).toBeUndefined();
    expect(kit.errors).toEqual([]);
  });

  it('gives up pushing a letter after the last attempt, and still delivers the ones after it', async () => {
    const adapter = new FakeAdapter({
      deliver: async (delivery: LetterDelivery) => {
        if (delivery.letter.body === 'Poison') throw new Error('rejected');
      },
    });
    kit = await makeKit({
      adapters: [adapter],
      limits: { deliveryAttempts: 2, deliveryBackoffMs: 1_000 },
    });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Poison' });
    await bridge.idle();
    clock.advance(1_000);
    await bridge.sweep();
    await bridge.idle();

    const [poison] = await bridge.letters({ job: 1 });
    expect(poison).toMatchObject({ state: 'queued', attempts: 2, lastError: 'rejected' });
    expect(poison.nextAttemptAt).toBeUndefined();
    expect((await bridge.readJournal({ job: 1 })).at(-1)).toMatchObject({
      type: 'letter.undelivered',
      letter: poison.id,
      data: { attempts: 2, error: 'rejected' },
    });

    await bridge.createJob(claude.name, { to: 'codex', body: 'Healthy' });
    await bridge.idle();
    expect(adapter.delivered.map((delivery) => delivery.letter.body)).toEqual(['Healthy']);
    expect(await bridge.inbox(codex.name)).toMatchObject([
      { body: 'Poison', state: 'read' },
      { body: 'Healthy' },
    ]);
  });

  it('is not held up by any number of letters it gave up on', async () => {
    const adapter = new FakeAdapter({
      deliver: async (delivery: LetterDelivery) => {
        if (delivery.letter.body.startsWith('Poison')) throw new Error('rejected');
      },
    });
    kit = await makeKit({ adapters: [adapter], limits: { deliveryAttempts: 1 } });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Carrier', budget: { letters: 500 } });
    await bridge.idle();
    for (let index = 0; index < 120; index += 1) {
      await bridge.send(claude.name, { job: 1, kind: 'note', body: `Poison ${index}` });
    }
    await bridge.idle();

    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Healthy' });
    await bridge.idle();

    expect(adapter.delivered.map((delivery) => delivery.letter.body)).toEqual([
      'Carrier',
      'Healthy',
    ]);
    expect(await bridge.letters({ job: 1, states: ['queued'], limit: 1000 })).toHaveLength(120);
  });

  it('counts a delivery that hangs as failed', async () => {
    const adapter = new FakeAdapter({ deliver: () => new Promise(() => undefined) });
    kit = await makeKit({ adapters: [adapter], limits: { deliveryTimeoutMs: 20 } });
    await kit.bridge.createJob(kit.claude.name, { to: 'codex', body: 'Do it' });
    await kit.bridge.idle();

    const [letter] = await kit.bridge.letters({ job: 1 });
    expect(letter).toMatchObject({ state: 'queued', attempts: 1 });
    expect(letter.lastError).toMatch(/took longer than 20 ms/);
  });

  it('does not deliver a letter the agent already took from its inbox', async () => {
    const gate = deferred<void>();
    const adapter = new FakeAdapter({ deliver: () => gate.promise });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'First' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Second' });

    expect(await bridge.inbox(codex.name)).toHaveLength(2);
    gate.resolve();
    await bridge.idle();

    expect(adapter.delivered.map((delivery) => delivery.letter.body)).toEqual(['First']);
    expect((await bridge.letters({})).map((letter) => letter.state)).toEqual(['read', 'read']);
  });

  it('waits for a delivery in flight before it closes, and records it', async () => {
    const gate = deferred<void>();
    const adapter = new FakeAdapter({ deliver: () => gate.promise });
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.createJob(kit.claude.name, { to: 'codex', body: 'Do it' });

    const closing = kit.bridge.close();
    gate.resolve();
    await closing;

    expect(kit.store.getLetter('ltr_1')?.state).toBe('delivered');
  });
});

describe('a session started for a job', () => {
  const sessionAdapter = (create: () => Promise<CreatedSession>) =>
    new FakeAdapter({ harness: 'gemini', createSession: create });

  it('gets a name at once and the job as soon as it is up', async () => {
    const adapter = sessionAdapter(async () => ({ sessionId: 'g-1', sessionName: 'Tests' }));
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;

    const { job } = await bridge.createJob(claude.name, {
      to: 'gemini',
      body: 'Write the tests',
      cwd: 'packages/a',
    });
    expect(job.to).toBe('gemini@demo');
    expect((await bridge.agents({ harness: 'gemini' }))[0]).toMatchObject({
      status: 'starting',
      sessionId: '',
      delivery: 'fake',
    });

    await bridge.idle();

    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.sessions[0]).toMatchObject({
      agentName: 'gemini@demo',
      harness: 'gemini',
      project: '/work/demo',
      cwd: '/work/demo/packages/a',
      job: { number: 1 },
    });
    expect(adapter.sessions[0].firstLetter.text).toContain('task from claude@demo to gemini@demo');
    expect((await bridge.agents({ harness: 'gemini' }))[0]).toMatchObject({
      status: 'active',
      sessionId: 'g-1',
      sessionName: 'Tests',
    });
    expect(adapter.delivered.map((delivery) => delivery.letter.kind)).toEqual(['task']);
    expect((await bridge.letters({ job: 1 }))[0].state).toBe('delivered');
    expect(kit.errors).toEqual([]);
  });

  it('is not sent the job a second time when it got it on start', async () => {
    const adapter = sessionAdapter(async () => ({ sessionId: 'g-1', deliveredFirstLetter: true }));
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.createJob(kit.claude.name, { to: 'gemini:new', body: 'Write the tests' });
    await kit.bridge.idle();

    expect(adapter.delivered).toEqual([]);
    expect((await kit.bridge.letters({ job: 1 }))[0].state).toBe('delivered');
  });

  it('is named as the address asked', async () => {
    const adapter = sessionAdapter(async () => ({ sessionId: 'g-1' }));
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.createJob(kit.claude.name, { to: 'gemini:reviewer', body: 'Review it' });
    await kit.bridge.idle();

    expect(adapter.sessions[0].sessionName).toBe('reviewer');
    expect((await kit.bridge.agents({ harness: 'gemini' }))[0].sessionName).toBe('reviewer');
  });

  it('fails the job when it cannot be started, and says why', async () => {
    const adapter = sessionAdapter(async () => {
      throw new Error('workspace not trusted');
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });
    await bridge.idle();

    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'the bridge could not start a gemini session: workspace not trusted',
    });
    expect((await bridge.agents({ harness: 'gemini' }))[0].status).toBe('gone');
    expect((await bridge.inbox(claude.name))[0].body).toContain('workspace not trusted');
    await expect(
      bridge.createJob(claude.name, { to: 'gemini@demo', body: 'Again' })
    ).rejects.toThrow(/gemini@demo is gone/);
    expect(kit.errors).toEqual([]);
  });

  it('fails the job when the adapter comes back without a session id, or never comes back', async () => {
    kit = await makeKit({
      adapters: [
        sessionAdapter(async () => ({ sessionId: ' ' })),
        new FakeAdapter({ harness: 'qwen', createSession: () => new Promise(() => undefined) }),
      ],
      limits: { sessionStartTimeoutMs: 20 },
    });
    await kit.bridge.createJob(kit.claude.name, { to: 'gemini', body: 'One' });
    await kit.bridge.createJob(kit.claude.name, { to: 'qwen', body: 'Two' });
    await kit.bridge.idle();

    expect((await kit.bridge.job(1)).reason).toMatch(/returned no session id/);
    expect((await kit.bridge.job(2)).reason).toMatch(/took longer than 20 ms/);
  });

  it('fails every job that waited for a session that could not be started', async () => {
    const started = deferred<CreatedSession>();
    const adapter = sessionAdapter(() => started.promise);
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'First' });
    const second = await bridge.createJob(claude.name, { to: 'gemini', body: 'Second' });
    expect(second.job.to).toBe('gemini@demo');

    started.reject(new Error('workspace not trusted'));
    await bridge.idle();

    expect((await bridge.jobs()).map((job) => job.state)).toEqual(['failed', 'failed']);
    expect(adapter.sessions).toHaveLength(1);
  });

  it('keeps the job of a session that came up by itself although its start timed out', async () => {
    const adapter = new FakeAdapter({
      harness: 'gemini',
      createSession: () => new Promise(() => undefined),
    });
    kit = await makeKit({ adapters: [adapter], limits: { sessionStartTimeoutMs: 30 } });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });
    await bridge.register({
      harness: 'gemini',
      sessionId: 'g-1',
      cwd: '/work/demo',
      project: '/work/demo',
      agentName: 'gemini@demo',
    });
    await bridge.idle();

    expect((await bridge.agents({ harness: 'gemini' }))[0]).toMatchObject({ status: 'active' });
    expect((await bridge.job(1)).state).toBe('working');
    expect(adapter.delivered.map((delivery) => delivery.letter.kind)).toEqual(['task']);
  });

  it('is given up on by the next dispatcher when the one that was starting it is gone', async () => {
    const adapter = new FakeAdapter({
      harness: 'gemini',
      createSession: () => new Promise(() => undefined),
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, store, clock } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });
    expect((await bridge.sweep()).failed).toEqual([]);

    const restarted = sessionAdapter(async () => ({ sessionId: 'g-2' }));
    const next = new BridgeDispatcher({ store, now: clock.now, adapters: [restarted] });
    expect((await next.sweep()).failed).toEqual([1]);

    expect((await next.job(1)).reason).toBe(
      'the session of gemini@demo never started: the dispatcher stopped while starting it'
    );
    expect((await next.agents({ harness: 'gemini' }))[0].status).toBe('gone');
    expect((await next.inbox(claude.name))[0].body).toContain('never started');

    const again = await next.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });
    await next.idle();
    expect(again.job.to).toBe('gemini-2@demo');
    expect((await next.agents({ harness: 'gemini', statuses: ['active'] }))[0].sessionId).toBe(
      'g-2'
    );
    kit.close = async () => store.close();
  });

  it('is not started while as many sessions as may start at once are starting', async () => {
    const adapter = new FakeAdapter({
      harness: 'gemini',
      createSession: () => new Promise(() => undefined),
    });
    kit = await makeKit({
      adapters: [adapter],
      limits: { maxStartingSessions: 1, sessionStartTimeoutMs: 500 },
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini:first', body: 'One' });

    await expect(
      bridge.createJob(claude.name, { to: 'gemini:second', body: 'Two' })
    ).rejects.toThrow(/already starting 1 sessions/);
    expect(adapter.sessions).toHaveLength(1);
  });

  it('is not claimed by a session of another project that names it', async () => {
    const started = deferred<CreatedSession>();
    const adapter = sessionAdapter(() => started.promise);
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });

    const stranger = await bridge.register({
      harness: 'gemini',
      sessionId: 'g-x',
      cwd: '/work/other',
      project: '/work/other',
      agentName: 'gemini@demo',
    });

    expect(stranger.name).toBe('gemini@other');
    expect(await bridge.inbox(stranger.name)).toEqual([]);
    started.resolve({ sessionId: 'g-1' });
    await bridge.idle();
    expect((await bridge.job(1)).to).toBe('gemini@demo');
  });

  it('is recognised when it calls the bridge before its adapter reports back', async () => {
    const started = deferred<CreatedSession>();
    const adapter = sessionAdapter(() => started.promise);
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });

    const self = await bridge.register({
      harness: 'gemini',
      sessionId: 'g-1',
      cwd: '/work/demo',
      project: '/work/demo',
      agentName: 'gemini@demo',
    });
    expect(self).toMatchObject({ name: 'gemini@demo', status: 'active', sessionId: 'g-1' });
    expect(await bridge.inbox(self.name)).toMatchObject([{ kind: 'task' }]);

    started.resolve({ sessionId: 'g-1' });
    await bridge.idle();

    expect(await bridge.agents({ harness: 'gemini' })).toHaveLength(1);
    expect(adapter.delivered).toEqual([]);
    expect((await bridge.job(1)).state).toBe('working');
  });

  it('is merged with the session that registered itself under another name', async () => {
    const started = deferred<CreatedSession>();
    const adapter = sessionAdapter(() => started.promise);
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Write the tests' });

    const self = await bridge.register({
      harness: 'gemini',
      sessionId: 'g-1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    expect(self.name).toBe('gemini-2@demo');

    started.resolve({ sessionId: 'g-1' });
    await bridge.idle();

    expect((await bridge.agents({ harness: 'gemini' })).map((agent) => agent.name)).toEqual([
      'gemini-2@demo',
    ]);
    expect((await bridge.job(1)).to).toBe('gemini-2@demo');
    expect(adapter.delivered.map((delivery) => delivery.agent.name)).toEqual(['gemini-2@demo']);
    await bridge.send(self.name, { job: 1, kind: 'report', body: 'Done' });
    expect((await bridge.job(1)).state).toBe('completed');
  });
});

describe('a session that went away', () => {
  it('gets the mail that came in the meantime once it calls the bridge again', async () => {
    const adapter = new FakeAdapter();
    kit = await makeKit({ adapters: [adapter], limits: { agentIdleMs: 60 * MINUTE } });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'A long one',
      budget: { durationMs: 20 * 60 * MINUTE, replyTimeoutMs: 6 * 60 * MINUTE },
    });
    await bridge.idle();
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    clock.advance(2 * 60 * MINUTE);
    await bridge.register({
      harness: 'claude-code',
      sessionId: 'session-claude',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.sweep();
    expect((await bridge.agents({ statuses: ['gone'] })).map((agent) => agent.name)).toEqual([
      'codex@demo',
    ]);
    kit.store.insertLetter({
      id: 'late',
      job: 1,
      kind: 'note',
      from: 'bridge',
      to: codex.name,
      body: 'While you were away',
      state: 'queued',
      createdAt: new Date(clock.now()).toISOString(),
      attempts: 0,
    });
    await bridge.sweep();
    await bridge.idle();
    expect(adapter.delivered.map((delivery) => delivery.letter.id)).not.toContain('late');

    const back = await bridge.register({
      harness: 'codex',
      sessionId: 'thread-codex',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.idle();

    expect(back).toMatchObject({ name: 'codex@demo', status: 'active' });
    expect(adapter.delivered.map((delivery) => delivery.letter.id)).toContain('late');
  });

  it('starts no session for a job handed over while the dispatcher closes', async () => {
    const started: string[] = [];
    const adapter = new FakeAdapter({
      harness: 'gemini',
      createSession: async (request) => {
        started.push(request.agentName);
        return { sessionId: 'g1' };
      },
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    const closing = bridge.close();
    const late = bridge.createJob(claude.name, { to: 'gemini', body: 'Review it' });

    await Promise.allSettled([closing, late]);

    expect(started).toEqual([]);
  });
});
