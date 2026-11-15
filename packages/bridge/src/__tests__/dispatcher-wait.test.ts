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

  it('takes a session that was listed and no longer is for gone, and fails its jobs', async () => {
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

    expect((await bridge.agents({ harness: 'codex' }))[0].status).toBe('gone');
    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'the session of codex@demo is not running any more',
    });
    expect(kit.errors).toEqual([]);
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
    clock.advance(MINUTE);
    await bridge.sweep();
    await bridge.idle();

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
