import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveSession } from '../adapter';
import type { BridgeCalls } from '../adapter';
import { FakeAdapter, makeKit, MINUTE, type Kit } from './bridge-kit';

let kit: Kit;

afterEach(async () => {
  vi.useRealTimers();
  await kit.close();
});

describe('waiting for mail', () => {
  it('answers at once with what is queued, and leaves it queued until it is confirmed', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });

    const waited = await bridge.wait(codex.name);

    expect(waited.reason).toBe('letters');
    expect(waited.letters.map((letter) => letter.id)).toEqual(['ltr_1']);
    expect(waited.letters[0].text.split('\n')[0]).toContain('not typed by the user');
    expect((await bridge.letters({ job: 1 }))[0].state).toBe('queued');
    expect((await bridge.job(1)).state).toBe('submitted');

    expect((await bridge.wait(codex.name)).letters.map((letter) => letter.id)).toEqual(['ltr_1']);
  });

  it('wakes the waiter the moment a letter is accepted', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;

    const waiting = bridge.wait(codex.name);
    expect((await bridge.status()).waiting).toEqual(['codex@demo']);
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });

    const waited = await waiting;
    expect(waited).toMatchObject({ reason: 'letters', letters: [{ id: 'ltr_1', kind: 'task' }] });
    expect((await bridge.status()).waiting).toEqual([]);
  });

  it('counts a confirmed job as taken, as one an adapter pushed', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Write the tests',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    const { letters } = await bridge.wait(codex.name);

    const marked = await bridge.delivered(
      codex.name,
      letters.map((letter) => letter.id)
    );

    expect(marked).toMatchObject([{ id: 'ltr_1', state: 'delivered' }]);
    expect(marked[0].replyDueAt).toBeUndefined();
    expect((await bridge.job(1)).state).toBe('working');
    const entry = (await bridge.readJournal({ job: 1 })).find(
      (journal) => journal.type === 'letter.delivered'
    );
    expect(entry).toMatchObject({ agent: 'codex@demo', letter: 'ltr_1', data: { via: 'wait' } });

    clock.advance(30 * MINUTE);
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });
  });

  it('offers a letter again to the next waiter when the one before died with it', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const gone = new AbortController();
    const dying = bridge.wait(codex.name, {}, gone.signal);
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    expect((await dying).letters).toHaveLength(1);

    const next = await bridge.wait(codex.name);

    expect(next.letters.map((letter) => letter.id)).toEqual(['ltr_1']);
  });

  it('keeps one waiter per session: a new one ends the one before it', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const first = bridge.wait(codex.name);
    const second = bridge.wait(codex.name);

    expect(await first).toEqual({ letters: [], reason: 'replaced' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    expect((await second).reason).toBe('letters');
  });

  it('ends with nothing when the time runs out', async () => {
    kit = await makeKit();
    vi.useFakeTimers();
    const waiting = kit.bridge.wait(kit.codex.name, { timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await kit.bridge.status()).waiting).toEqual(['codex@demo']);

    await vi.advanceTimersByTimeAsync(1);

    expect(await waiting).toEqual({ letters: [], reason: 'timeout' });
    expect((await kit.bridge.status()).waiting).toEqual([]);
  });

  it('ends when its connection closes, and when the dispatcher does', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const gone = new AbortController();
    const dropped = bridge.wait(codex.name, {}, gone.signal);
    await bridge.status();
    gone.abort();
    expect(await dropped).toEqual({ letters: [], reason: 'closed' });
    expect((await bridge.status()).waiting).toEqual([]);

    const already = new AbortController();
    already.abort();
    expect(await bridge.wait(codex.name, {}, already.signal)).toEqual({
      letters: [],
      reason: 'closed',
    });

    const open = bridge.wait(claude.name);
    await bridge.status();
    await bridge.close();
    expect(await open).toEqual({ letters: [], reason: 'closed' });
  });

  it('takes no more letters than asked for, the rest wait for the next waiter', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Use vitest' });
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Cover the burst case' });

    const first = await bridge.wait(codex.name, { limit: 2 });
    await bridge.delivered(
      codex.name,
      first.letters.map((letter) => letter.id)
    );
    const second = await bridge.wait(codex.name, { limit: 2 });

    expect(first.letters.map((letter) => letter.id)).toEqual(['ltr_1', 'ltr_2']);
    expect(second.letters.map((letter) => letter.id)).toEqual(['ltr_3']);
  });

  it('leaves a letter the session read from its inbox meanwhile as it is', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    const { letters } = await bridge.wait(codex.name);
    await bridge.inbox(codex.name);

    const marked = await bridge.delivered(codex.name, [letters[0].id]);

    expect(marked).toMatchObject([{ id: 'ltr_1', state: 'read' }]);
    expect(
      (await bridge.readJournal({ job: 1 })).filter((entry) => entry.type === 'letter.delivered')
    ).toEqual([]);
  });

  it('refuses to confirm a letter of somebody else, and input it cannot read', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });

    await expect(bridge.delivered(claude.name, ['ltr_1'])).rejects.toMatchObject({
      code: 'unknown_letter',
    });
    await expect(bridge.delivered(codex.name, [])).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(bridge.wait(codex.name, { timeoutMs: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(bridge.wait('nobody@demo')).rejects.toMatchObject({ code: 'not_registered' });
    expect((await bridge.letters({ job: 1 }))[0].state).toBe('queued');
  });

  it('never gives a letter a waiter holds to the adapter too, nor one being pushed to a waiter', async () => {
    const pushes: string[] = [];
    let finishPush: () => void = () => undefined;
    const adapter = new FakeAdapter({
      deliver: (delivery) => {
        pushes.push(delivery.letter.id);
        return new Promise<void>((resolve) => {
          finishPush = resolve;
        });
      },
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex, clock } = kit;
    const waiting = bridge.wait(codex.name);
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    const held = await waiting;
    expect(held.letters.map((letter) => letter.id)).toEqual(['ltr_1']);

    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Use vitest' });
    await bridge.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pushes).toEqual([]);

    await bridge.delivered(codex.name, ['ltr_1']);
    await new Promise((resolve) => setImmediate(resolve));
    await bridge.status();
    expect(pushes).toEqual(['ltr_2']);
    const during = bridge.wait(codex.name, { timeoutMs: 60_000 });
    await bridge.status();
    expect((await bridge.status()).waiting).toEqual(['codex@demo']);

    finishPush();
    await bridge.idle();
    expect((await bridge.letters({ job: 1 })).map((letter) => letter.state)).toEqual([
      'delivered',
      'delivered',
    ]);
    clock.advance(1);
    await bridge.close();
    expect((await during).reason).toBe('closed');
  });

  it('frees what a waiter held when its connection closes or its time is up', async () => {
    kit = await makeKit({ limits: { deliveryTimeoutMs: 30_000 } });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    const gone = new AbortController();
    expect((await bridge.wait(codex.name, {}, gone.signal)).letters).toHaveLength(1);

    const other = bridge.wait(claude.name);
    await bridge.status();
    gone.abort();
    await bridge.idle();
    expect((await bridge.letters({ job: 1 }))[0].state).toBe('queued');

    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Use vitest' });
    const second = await bridge.wait(codex.name, { limit: 1 });
    expect(second.letters.map((letter) => letter.id)).toEqual(['ltr_1']);
    const behind = bridge.wait(codex.name, { limit: 1 });
    expect((await behind).letters.map((letter) => letter.id)).toEqual(['ltr_1']);

    clock.advance(30_000);
    await bridge.close();
    expect((await other).reason).toBe('closed');
  });

  it('holds the first letter back from a waiter while the session is still being started', async () => {
    let finish: (created: { sessionId: string; deliveredFirstLetter: boolean }) => void = () =>
      undefined;
    const adapter = new FakeAdapter({
      harness: 'gemini',
      createSession: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;
    const { job } = await bridge.createJob(claude.name, { to: 'gemini', body: 'Review it' });
    const early = await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
      agentName: job.to,
    });

    const waiting = bridge.wait(early.name, { timeoutMs: 60_000 });
    await bridge.status();
    expect((await bridge.status()).waiting).toEqual([job.to]);

    finish({ sessionId: 'g1', deliveredFirstLetter: true });
    await bridge.idle();
    expect((await bridge.letters({ job: 1 }))[0].state).toBe('delivered');
    await bridge.close();
    expect(await waiting).toEqual({ letters: [], reason: 'closed' });
  });

  it('hands the mail to the waiter rather than pushing it through the adapter', async () => {
    const adapter = new FakeAdapter();
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex } = kit;
    const waiting = bridge.wait(codex.name);

    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    await bridge.idle();

    expect((await waiting).letters).toHaveLength(1);
    expect(adapter.delivered).toEqual([]);
  });

  it('keeps a letter for a harness whose adapter does not push until its waiter comes', async () => {
    const adapter = { harness: 'codex', delivery: 'wait', capabilities: pushing() };
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    await bridge.idle();
    clock.advance(MINUTE);
    await bridge.sweep();
    await bridge.idle();

    expect((await bridge.letters({ job: 1 }))[0]).toMatchObject({ state: 'queued', attempts: 0 });
    expect((await bridge.wait(codex.name)).letters).toHaveLength(1);
    expect(kit.errors).toEqual([]);
  });

  it('does not take a session with a waiter armed for idle', async () => {
    kit = await makeKit({ limits: { agentIdleMs: 10 * MINUTE } });
    const { bridge, codex, clock } = kit;
    const waiting = bridge.wait(codex.name);
    await bridge.status();
    clock.advance(11 * MINUTE);

    await bridge.sweep();

    const agents = await bridge.agents();
    expect(agents.find((agent) => agent.name === 'codex@demo')?.status).toBe('active');
    expect(agents.find((agent) => agent.name === 'claude@demo')?.status).toBe('gone');
    await bridge.close();
    await waiting;
  });
});

function pushing() {
  return { createSession: false, push: true, steer: false, nativeWindow: true };
}

describe('what an adapter says about a delivery', () => {
  it('keeps the note of the receipt in the journal', async () => {
    const adapter = new FakeAdapter({
      deliver: async () => ({ note: 'queued, but nothing will wake the thread' }),
    });
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.createJob(kit.claude.name, { to: 'codex', body: 'Write the tests' });
    await kit.bridge.idle();

    const entry = (await kit.bridge.readJournal({ job: 1 })).find(
      (journal) => journal.type === 'letter.delivered'
    );
    expect(entry?.data).toEqual({ note: 'queued, but nothing will wake the thread' });
  });

  it('gives the adapter the calls its own sessions make, once', async () => {
    const attached: BridgeCalls[] = [];
    const adapter = {
      harness: 'qwen',
      delivery: 'hosted',
      capabilities: pushing(),
      attach: (bridge: BridgeCalls) => {
        attached.push(bridge);
      },
    };
    kit = await makeKit({ adapters: [adapter] });

    expect(attached).toEqual([kit.bridge]);
    const hosted = await attached[0].register({
      harness: 'qwen',
      sessionId: 'run-1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    expect(hosted).toMatchObject({ name: 'qwen@demo', delivery: 'hosted' });
  });
});

describe('sessions a harness lists', () => {
  function listed(sessions: { current: LiveSession[] }) {
    return new FakeAdapter({ liveSessions: async () => sessions.current });
  }

  it('takes a session that was listed and is missing twice in a row for gone, and fails its jobs', async () => {
    const sessions = { current: [{ sessionId: 'thread-codex' }] };
    kit = await makeKit({ adapters: [listed(sessions)] });
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    await bridge.sweep();
    await bridge.idle();
    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('active');

    sessions.current = [];
    clock.advance(MINUTE);
    await bridge.sweep();
    await bridge.idle();
    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('active');
    expect((await bridge.job(1)).state).toBe('working');

    clock.advance(MINUTE);
    await bridge.sweep();
    await bridge.idle();

    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('gone');
    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'the session of codex@demo is not running any more',
    });
    expect(kit.errors).toEqual([]);
  });

  it('forgives one miss: a session back in the list is counted from the start', async () => {
    const sessions = { current: [{ sessionId: 'thread-codex' }] };
    kit = await makeKit({ adapters: [listed(sessions)] });
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    const look = async (current: LiveSession[]) => {
      sessions.current = current;
      clock.advance(MINUTE);
      await bridge.sweep();
      await bridge.idle();
    };
    await look([{ sessionId: 'thread-codex' }]);

    await look([]);
    await look([{ sessionId: 'thread-codex' }]);
    await look([]);

    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('active');
    await look([]);
    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('gone');
  });

  it('believes an adapter that runs every session itself at the first look', async () => {
    const adapter = Object.assign(new FakeAdapter({ liveSessions: async () => [] }), {
      ownsSessions: true,
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    clock.advance(1);

    await bridge.sweep();
    await bridge.idle();

    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('gone');
    expect((await bridge.job(1)).state).toBe('failed');
  });

  it('does not judge a session that came after the list was asked for by that list', async () => {
    let answer: (sessions: LiveSession[]) => void = () => undefined;
    const adapter = Object.assign(
      new FakeAdapter({
        liveSessions: () =>
          new Promise<LiveSession[]>((resolve) => {
            answer = resolve;
          }),
      }),
      { ownsSessions: true }
    );
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, clock } = kit;
    clock.advance(1);
    await bridge.sweep();
    clock.advance(1);
    await bridge.register({
      harness: 'codex',
      sessionId: 'started-meanwhile',
      cwd: '/work/demo',
      project: '/work/demo',
    });

    answer([]);
    await bridge.idle();

    const agents = await bridge.agents({ harness: 'codex' });
    expect(Object.fromEntries(agents.map((agent) => [agent.sessionId, agent.status]))).toEqual({
      'thread-codex': 'gone',
      'started-meanwhile': 'active',
    });
  });

  it('leaves a session the harness never listed to the idle rule', async () => {
    const sessions = { current: [] as LiveSession[] };
    kit = await makeKit({ adapters: [listed(sessions)] });
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });
    await bridge.sweep();
    await bridge.idle();
    clock.advance(MINUTE);
    await bridge.sweep();
    await bridge.idle();

    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('active');
    expect((await bridge.job(1)).state).toBe('working');
  });

  it('asks no more often than the limit says, and keeps a listed session however silent', async () => {
    let asked = 0;
    const adapter = new FakeAdapter({
      liveSessions: async () => {
        asked += 1;
        return [{ sessionId: 'thread-codex' }];
      },
    });
    kit = await makeKit({
      adapters: [adapter],
      limits: { agentIdleMs: 10 * MINUTE, presenceCheckMs: 5 * MINUTE },
    });
    const { bridge, clock } = kit;
    await bridge.sweep();
    await bridge.sweep();
    await bridge.idle();
    expect(asked).toBe(1);

    clock.advance(11 * MINUTE);
    await bridge.sweep();
    await bridge.idle();

    expect(asked).toBe(2);
    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('active');
    expect((await bridge.agents({ harness: 'claude-code' }))[0].status).toBe('gone');
  });

  it('does not take a session with a waiter armed for gone when the harness stops listing it', async () => {
    const sessions = { current: [{ sessionId: 'thread-codex' }] };
    kit = await makeKit({ adapters: [listed(sessions)] });
    const { bridge, codex, clock } = kit;
    await bridge.sweep();
    await bridge.idle();
    const waiting = bridge.wait(codex.name);
    await bridge.status();

    sessions.current = [];
    for (let look = 0; look < 3; look += 1) {
      clock.advance(MINUTE);
      await bridge.sweep();
      await bridge.idle();
    }

    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('active');
    await bridge.close();
    await waiting;
  });

  it('reports a listing that fails and changes nothing', async () => {
    const adapter = new FakeAdapter({
      liveSessions: async () => {
        throw new Error('codex is not installed');
      },
    });
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.sweep();
    await kit.bridge.idle();

    expect(kit.errors.map((error) => error.message)).toEqual(['codex is not installed']);
    expect((await kit.bridge.agents({ harness: 'codex' }))[0].status).toBe('active');
  });
});

describe('a session that ended its turn without a report', () => {
  /** A job the Codex session took through its waiter: the session works on it now. */
  async function taken(options: Parameters<typeof makeKit>[0] = {}): Promise<Kit> {
    kit = await makeKit(options);
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Review the parser' });
    const { letters } = await bridge.wait(codex.name);
    await bridge.delivered(
      codex.name,
      letters.map((letter) => letter.id)
    );
    return kit;
  }

  /** Waits as the session's hook does, and confirms what it was handed. */
  async function woken(made: Kit): Promise<string[]> {
    const { letters } = await made.bridge.wait(made.codex.name);
    await made.bridge.delivered(
      made.codex.name,
      letters.map((letter) => letter.id)
    );
    return letters.map((letter) => letter.body);
  }

  it('is reminded to report once it has waited for mail for a while, and woken by the reminder', async () => {
    const { bridge, codex, clock } = await taken();
    const waiting = bridge.wait(codex.name);
    await bridge.status();

    clock.advance(30_000);
    await bridge.sweep();
    expect(await bridge.letters({ job: 1, kinds: ['note'] })).toEqual([]);

    clock.advance(31_000);
    await bridge.sweep();
    const waited = await waiting;
    expect(waited.reason).toBe('letters');
    expect(waited.letters).toHaveLength(1);
    expect(waited.letters[0]).toMatchObject({ kind: 'note', from: 'bridge', job: 1 });
    expect(waited.letters[0].body).toContain(
      'You ended your turn, and job #1 is still in progress: claude@demo has no report from you.'
    );
    expect((await bridge.job(1)).reportAskedAt).toBeDefined();
  });

  it('is reminded once, and its job fails when it does not react in the time an answer has', async () => {
    const made = await taken();
    const { bridge, claude, codex, clock } = made;
    const first = woken(made);
    await bridge.status();
    clock.advance(61_000);
    await bridge.sweep();
    expect((await first)[0]).toContain('You ended your turn');

    const again = bridge.wait(codex.name);
    await bridge.status();
    clock.advance(10 * MINUTE);
    await bridge.sweep();
    expect(await bridge.letters({ job: 1, kinds: ['note'] })).toHaveLength(1);
    expect((await bridge.job(1)).state).toBe('working');

    clock.advance(21 * MINUTE);
    const swept = await bridge.sweep();
    expect(swept.failed).toEqual([1]);
    const failed = await bridge.job(1);
    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe(
      'codex@demo ended its turn without a report and did not react to the reminder in 30 min'
    );
    expect((await again).letters[0].body).toContain('Job #1 has failed');
    expect((await bridge.inbox(claude.name)).at(-1)?.body).toContain('Job #1 has failed');
  });

  it('keeps the job of a session that reacts, and reminds it again no sooner than that time', async () => {
    const made = await taken();
    const { bridge, codex, clock } = made;
    const first = woken(made);
    await bridge.status();
    clock.advance(61_000);
    await bridge.sweep();
    await first;
    await bridge.send(codex.name, {
      job: 1,
      kind: 'note',
      body: 'Still reading, half an hour more',
    });

    void bridge.wait(codex.name);
    await bridge.status();
    clock.advance(20 * MINUTE);
    await bridge.sweep();
    expect(await bridge.letters({ job: 1, from: 'bridge' })).toHaveLength(1);

    clock.advance(11 * MINUTE);
    const swept = await bridge.sweep();
    expect(swept.failed).toEqual([]);
    expect((await bridge.job(1)).state).toBe('working');
    expect(await bridge.letters({ job: 1, from: 'bridge' })).toHaveLength(2);
  });

  it('is left alone while its harness lists it in the middle of a turn', async () => {
    const sessions: { current: LiveSession[] } = {
      current: [{ sessionId: 'thread-codex', busy: true }],
    };
    const adapter = new FakeAdapter({
      liveSessions: async () => sessions.current,
      capabilities: { push: false },
    });
    const { bridge, codex, clock } = await taken({
      adapters: [adapter],
      limits: { presenceCheckMs: 1_000 },
    });
    void bridge.wait(codex.name);
    await bridge.status();
    await bridge.sweep();
    await bridge.idle();

    clock.advance(2 * MINUTE);
    await bridge.sweep();
    await bridge.idle();
    expect(await bridge.letters({ job: 1, from: 'bridge' })).toEqual([]);

    sessions.current = [{ sessionId: 'thread-codex', busy: false }];
    clock.advance(2_000);
    await bridge.sweep();
    await bridge.idle();
    clock.advance(2_000);
    await bridge.sweep();
    expect(await bridge.letters({ job: 1, from: 'bridge' })).toHaveLength(1);
  });

  it('is left alone while it waits for an answer, for a job it handed over, or for its checks', async () => {
    const { bridge, claude, codex, clock } = await taken();
    await bridge.send(codex.name, { job: 1, kind: 'question', body: 'Which parser?' });
    void bridge.wait(codex.name);
    await bridge.status();
    clock.advance(5 * MINUTE);
    await bridge.sweep();
    expect(await bridge.letters({ job: 1, from: 'bridge' })).toEqual([]);

    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'The new one' });
    const { letters } = await bridge.wait(codex.name);
    await bridge.delivered(
      codex.name,
      letters.map((letter) => letter.id)
    );
    await bridge.createJob(codex.name, { to: claude.name, body: 'Tell me which tests matter' });
    void bridge.wait(codex.name);
    await bridge.status();
    clock.advance(5 * MINUTE);
    await bridge.sweep();
    expect(await bridge.letters({ job: 1, from: 'bridge' })).toEqual([]);
    expect((await bridge.job(1)).state).toBe('working');
  });
});
