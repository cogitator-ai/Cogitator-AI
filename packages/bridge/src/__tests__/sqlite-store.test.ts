import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { TASK_AGENT_KEY, TaskManager, textPart, toMessage } from '@cogitator-ai/a2a';
import { SqliteBridgeStore, BRIDGE_SCHEMA_VERSION } from '../store/sqlite';
import { BridgeError } from '../errors';
import { BRIDGE_JOB_KEY, DEFAULT_LIMITS, type BridgeJobRecord } from '../types';
import { jobOf } from '../job-record';
import { agentRecord, at, letterInput, T0, tempDir } from './helpers';

function jobRecord(overrides: Partial<BridgeJobRecord> = {}): BridgeJobRecord {
  return {
    number: 1,
    title: 'Write the tests',
    from: 'claude@demo',
    to: 'codex@demo',
    project: '/work/demo',
    cwd: '/work/demo',
    checks: [],
    budget: DEFAULT_LIMITS.budget,
    lettersUsed: 0,
    depth: 1,
    createdAt: at(),
    deadlineAt: at(3_600_000),
    ...overrides,
  };
}

const userMessage = (text: string) => toMessage({ role: 'user', parts: [textPart(text)] });

describe('SqliteBridgeStore', () => {
  let store: SqliteBridgeStore;

  beforeEach(async () => {
    store = await SqliteBridgeStore.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('tasks', () => {
    it('runs a TaskManager and finds a job by its number', async () => {
      const tasks = new TaskManager({ taskStore: store.tasks });
      const number = store.nextJobNumber();
      const task = await tasks.createTask(userMessage('Write the tests'), undefined, {
        metadata: { [BRIDGE_JOB_KEY]: jobRecord({ number }) },
      });
      await tasks.advanceTask(task.id, { state: 'working' });

      const found = store.taskOfJob(number);
      expect(found?.id).toBe(task.id);
      expect(jobOf(found!)).toMatchObject({ number, state: 'working', to: 'codex@demo' });
    });

    it('numbers jobs 1, 2, 3 and never reuses a number', () => {
      expect([store.nextJobNumber(), store.nextJobNumber(), store.nextJobNumber()]).toEqual([
        1, 2, 3,
      ]);
    });

    it('lists job tasks by state, party and project, newest job first', async () => {
      const tasks = new TaskManager({ taskStore: store.tasks });
      const create = async (record: Partial<BridgeJobRecord>) => {
        const number = store.nextJobNumber();
        return tasks.createTask(userMessage('x'), undefined, {
          metadata: { [BRIDGE_JOB_KEY]: jobRecord({ number, ...record }) },
        });
      };
      const first = await create({});
      await create({ from: 'codex@demo', to: 'gemini@demo' });
      await create({ project: '/work/other', to: 'claude@other' });
      await tasks.advanceTask(first.id, { state: 'completed', message: 'Done' });
      await tasks.createTask(userMessage('not a job'));

      const numbers = (filter: Parameters<typeof store.jobTasks>[0]) =>
        store.jobTasks(filter).map((task) => jobOf(task)?.number);
      expect(numbers({})).toEqual([3, 2, 1]);
      expect(numbers({ states: ['completed'] })).toEqual([1]);
      expect(numbers({ states: [] })).toEqual([]);
      expect(numbers({ party: 'codex@demo' })).toEqual([2, 1]);
      expect(numbers({ to: 'codex@demo' })).toEqual([1]);
      expect(numbers({ from: 'codex@demo' })).toEqual([2]);
      expect(numbers({ project: '/work/other' })).toEqual([3]);
      expect(numbers({ limit: 2 })).toEqual([3, 2]);
    });

    it('finds the jobs handed over from inside a job, and those created since a time', async () => {
      const tasks = new TaskManager({ taskStore: store.tasks });
      const create = async (record: Partial<BridgeJobRecord>) => {
        const number = store.nextJobNumber();
        await tasks.createTask(userMessage('x'), undefined, {
          metadata: { [BRIDGE_JOB_KEY]: jobRecord({ number, ...record }) },
        });
      };
      await create({});
      await create({ parent: 1, createdAt: at(5_000) });
      await create({ parent: 1, createdAt: at(9_000) });
      const numbers = (filter: Parameters<typeof store.jobTasks>[0]) =>
        store.jobTasks(filter).map((task) => jobOf(task)?.number);

      expect(numbers({ parent: 1 })).toEqual([3, 2]);
      expect(numbers({ parent: 2 })).toEqual([]);
      expect(numbers({ createdSince: T0 + 5_000 })).toEqual([3, 2]);
      expect(numbers({ from: 'claude@demo', createdSince: T0 + 9_001 })).toEqual([]);
    });

    it('finds the jobs that are past their deadline', async () => {
      const tasks = new TaskManager({ taskStore: store.tasks });
      for (const deadlineAt of [at(1_000), at(5_000)]) {
        const number = store.nextJobNumber();
        await tasks.createTask(userMessage('x'), undefined, {
          metadata: { [BRIDGE_JOB_KEY]: jobRecord({ number, deadlineAt }) },
        });
      }
      const overdue = (deadlineBy: number) =>
        store.jobTasks({ deadlineBy }).map((task) => jobOf(task)?.number);

      expect(overdue(T0 + 999)).toEqual([]);
      expect(overdue(T0 + 1_000)).toEqual([1]);
      expect(overdue(T0 + 5_000)).toEqual([2, 1]);
    });

    it('lists tasks as the A2A store contract asks: filters, visibility, newest first, paging', async () => {
      const tasks = new TaskManager({ taskStore: store.tasks });
      const mine = await tasks.createTask(userMessage('mine'), 'ctx_a', 'alice');
      const shared = await tasks.createTask(userMessage('shared'), 'ctx_a');
      await tasks.createTask(userMessage('theirs'), 'ctx_b', 'bob');
      await tasks.advanceTask(shared.id, { state: 'working' });

      const ids = async (filter: Parameters<typeof store.tasks.list>[0]) =>
        (await store.tasks.list(filter)).map((task) => task.id);
      expect(await ids({ contextId: 'ctx_a' })).toHaveLength(2);
      expect(await ids({ state: 'working' })).toEqual([shared.id]);
      expect((await ids({ visibleTo: 'alice' })).sort()).toEqual([mine.id, shared.id].sort());
      expect(await ids({ visibleTo: null })).toEqual([shared.id]);
      expect(await ids({})).toHaveLength(3);
      expect(await ids({ limit: 1, offset: 1 })).toHaveLength(1);
    });

    it('ignores an update of a task it does not have, and deletes', async () => {
      await store.tasks.update('nope', { contextId: 'x' });
      expect(await store.tasks.get('nope')).toBeNull();

      const tasks = new TaskManager({ taskStore: store.tasks });
      const task = await tasks.createTask(userMessage('x'));
      await store.tasks.delete(task.id);
      expect(await store.tasks.get(task.id)).toBeNull();
    });
  });

  describe('agents', () => {
    it('keeps an agent and finds it by name and by session', () => {
      store.putAgent(agentRecord({ sessionName: 'Rate limiter' }));

      expect(store.getAgent('claude@demo')).toEqual(agentRecord({ sessionName: 'Rate limiter' }));
      expect(store.agentOfSession('claude-code', 'session-claude')?.name).toBe('claude@demo');
      expect(store.agentOfSession('codex', 'session-claude')).toBeUndefined();
      expect(store.getAgent('nobody')).toBeUndefined();
    });

    it('updates an agent in place', () => {
      store.putAgent(agentRecord());
      store.putAgent(agentRecord({ cwd: '/work/demo/packages/a', lastSeenAt: at(5_000) }));

      expect(store.listAgents()).toHaveLength(1);
      expect(store.getAgent('claude@demo')).toMatchObject({
        cwd: '/work/demo/packages/a',
        lastSeenAt: at(5_000),
      });
    });

    it('refuses a second agent for the same session of a harness', () => {
      store.putAgent(agentRecord());
      expect(() => store.putAgent(agentRecord({ name: 'claude-2@demo' }))).toThrow(/UNIQUE/);
    });

    it('lets several starting sessions wait for their ids', () => {
      store.putAgent(
        agentRecord({ name: 'codex@demo', harness: 'codex', sessionId: '', status: 'starting' })
      );
      store.putAgent(
        agentRecord({ name: 'codex-2@demo', harness: 'codex', sessionId: '', status: 'starting' })
      );

      expect(store.listAgents({ statuses: ['starting'] })).toHaveLength(2);
      expect(store.agentOfSession('codex', '')).toBeUndefined();
    });

    it('filters agents by project, harness and status', () => {
      store.putAgent(agentRecord());
      store.putAgent(agentRecord({ name: 'codex@demo', harness: 'codex', sessionId: 's2' }));
      store.putAgent(
        agentRecord({
          name: 'claude@other',
          sessionId: 's3',
          project: '/work/other',
          status: 'gone',
        })
      );

      const names = (filter: Parameters<typeof store.listAgents>[0]) =>
        store.listAgents(filter).map((agent) => agent.name);
      expect(names({ project: '/work/demo' })).toEqual(['claude@demo', 'codex@demo']);
      expect(names({ harness: 'claude-code' })).toEqual(['claude@demo', 'claude@other']);
      expect(names({ statuses: ['gone'] })).toEqual(['claude@other']);
      expect(names({ statuses: [] })).toEqual([]);
    });

    it('finds the agents that were last heard from before a time', () => {
      store.putAgent(agentRecord({ lastSeenAt: at(1_000) }));
      store.putAgent(
        agentRecord({
          name: 'codex@demo',
          harness: 'codex',
          sessionId: 's2',
          lastSeenAt: at(9_000),
        })
      );

      const names = (seenBefore: number) =>
        store.listAgents({ statuses: ['active'], seenBefore }).map((agent) => agent.name);
      expect(names(T0 + 1_000)).toEqual([]);
      expect(names(T0 + 1_001)).toEqual(['claude@demo']);
      expect(names(T0 + 10_000)).toEqual(['claude@demo', 'codex@demo']);
    });

    it('merges an agent into another: its letters and jobs change hands', async () => {
      const tasks = new TaskManager({ taskStore: store.tasks });
      store.putAgent(
        agentRecord({ name: 'codex@demo', harness: 'codex', sessionId: '', status: 'starting' })
      );
      store.putAgent(agentRecord({ name: 'codex-2@demo', harness: 'codex', sessionId: 's9' }));
      const number = store.nextJobNumber();
      const task = await tasks.createTask(userMessage('x'), undefined, {
        agentName: 'codex@demo',
        metadata: { [BRIDGE_JOB_KEY]: jobRecord({ number, to: 'codex@demo' }) },
      });
      store.insertLetter(letterInput({ id: 'a', to: 'codex@demo' }));
      store.insertLetter(
        letterInput({ id: 'b', from: 'codex@demo', to: 'claude@demo', kind: 'question' })
      );

      store.mergeAgent('codex@demo', 'codex-2@demo');

      expect(store.getAgent('codex@demo')).toBeUndefined();
      expect(store.getLetter('a')?.to).toBe('codex-2@demo');
      expect(store.getLetter('b')?.from).toBe('codex-2@demo');
      expect(jobOf(store.taskOfJob(number)!)?.to).toBe('codex-2@demo');
      expect(store.jobTasks({ to: 'codex-2@demo' })).toHaveLength(1);
      expect((await store.tasks.get(task.id))?.metadata?.[TASK_AGENT_KEY]).toBe('codex-2@demo');
    });
  });

  describe('letters', () => {
    it('keeps a letter in the order it was accepted', () => {
      const first = store.insertLetter(letterInput({ id: 'a' }));
      const second = store.insertLetter(letterInput({ id: 'b', inReplyTo: 'a', kind: 'answer' }));

      expect(second.seq).toBeGreaterThan(first.seq);
      expect(store.getLetter('b')).toEqual({
        ...letterInput({ id: 'b', inReplyTo: 'a', kind: 'answer' }),
        seq: second.seq,
      });
      expect(store.getLetter('zzz')).toBeUndefined();
    });

    it('refuses a second letter with the same id', () => {
      store.insertLetter(letterInput());
      expect(() => store.insertLetter(letterInput())).toThrow(/UNIQUE/);
    });

    it('updates delivery fields and clears the ones named', () => {
      store.insertLetter(
        letterInput({ nextAttemptAt: at(1_000), lastError: 'boom', replyDueAt: at(9_000) })
      );

      const updated = store.updateLetter('ltr_1', {
        state: 'delivered',
        deliveredAt: at(2_000),
        attempts: 2,
        clear: ['lastError', 'nextAttemptAt'],
      });

      expect(updated).toMatchObject({
        state: 'delivered',
        deliveredAt: at(2_000),
        attempts: 2,
        replyDueAt: at(9_000),
      });
      expect(updated.lastError).toBeUndefined();
      expect(updated.nextAttemptAt).toBeUndefined();
    });

    it('finds the letters that still have delivery attempts left, and who has mail waiting', () => {
      store.insertLetter(letterInput({ id: 'a', attempts: 5 }));
      store.insertLetter(letterInput({ id: 'b', attempts: 4 }));
      store.insertLetter(letterInput({ id: 'c', to: 'gemini@demo', state: 'read' }));
      store.insertLetter(letterInput({ id: 'd', to: 'claude@demo', from: 'codex@demo' }));

      const next = store.listLetters({
        to: 'codex@demo',
        states: ['queued'],
        attemptsBelow: 5,
        limit: 1,
      });
      expect(next.map((letter) => letter.id)).toEqual(['b']);
      expect(store.queuedRecipients()).toEqual(['claude@demo', 'codex@demo']);
    });

    it('throws for an update of a letter it does not have', () => {
      expect(() => store.updateLetter('nope', { state: 'read' })).toThrow(BridgeError);
    });

    it('filters letters and counts them', () => {
      store.insertLetter(letterInput({ id: 'a' }));
      store.insertLetter(
        letterInput({
          id: 'b',
          kind: 'question',
          from: 'codex@demo',
          to: 'claude@demo',
          replyDueAt: at(10_000),
        })
      );
      store.insertLetter(
        letterInput({ id: 'c', job: 2, state: 'delivered', nextAttemptAt: at(5_000) })
      );

      const ids = (filter: Parameters<typeof store.listLetters>[0]) =>
        store.listLetters(filter).map((letter) => letter.id);
      expect(ids({})).toEqual(['a', 'b', 'c']);
      expect(ids({ newestFirst: true, limit: 2 })).toEqual(['c', 'b']);
      expect(ids({ job: 1 })).toEqual(['a', 'b']);
      expect(ids({ to: 'codex@demo', states: ['queued'] })).toEqual(['a']);
      expect(ids({ from: 'codex@demo' })).toEqual(['b']);
      expect(ids({ kinds: ['question', 'permission'] })).toEqual(['b']);
      expect(ids({ afterSeq: store.getLetter('a')!.seq })).toEqual(['b', 'c']);
      expect(ids({ replyDueBy: T0 + 10_000 })).toEqual(['b']);
      expect(ids({ states: [] })).toEqual([]);
      expect(store.countLetters({ job: 1 })).toBe(2);
      expect(store.countLetters({ kinds: [] })).toBe(0);
    });

    it('keeps the call a permission request names, its verdict and who it waits for', () => {
      const ask = {
        tool: 'Bash',
        access: 'command' as const,
        command: 'git push origin main',
        cwd: '/work/demo',
      };
      store.insertLetter(letterInput({ id: 'plain' }));
      store.insertLetter(
        letterInput({
          id: 'request',
          kind: 'permission',
          ask,
          needsPerson: true,
          personAskedAt: at(1_000),
        })
      );
      store.insertLetter(
        letterInput({ id: 'decision', kind: 'answer', inReplyTo: 'request', verdict: 'allow' })
      );

      const ids = (filter: Parameters<typeof store.listLetters>[0]) =>
        store.listLetters(filter).map((letter) => letter.id);
      expect(store.getLetter('request')).toMatchObject({
        ask,
        needsPerson: true,
        personAskedAt: at(1_000),
      });
      expect(store.getLetter('decision')).toMatchObject({ verdict: 'allow' });
      expect(store.getLetter('plain')).not.toHaveProperty('ask');
      expect(store.getLetter('plain')).not.toHaveProperty('needsPerson');
      expect(ids({ needsPerson: true })).toEqual(['request']);
      expect(ids({ needsPerson: false })).toEqual(['plain', 'decision']);
      expect(ids({ inReplyTo: 'request' })).toEqual(['decision']);

      const passed = store.updateLetter('plain', {
        needsPerson: true,
        personAskedAt: at(2_000),
        remindedAt: at(3_000),
      });
      expect(passed).toMatchObject({ needsPerson: true, personAskedAt: at(2_000) });
      expect(store.updateLetter('plain', { clear: ['remindedAt'] })).not.toHaveProperty(
        'remindedAt'
      );
    });
  });

  describe('journal', () => {
    it('appends entries and reads them back in order', () => {
      store.appendJournal({ at: at(), type: 'job.created', job: 1, data: { title: 'x' } });
      store.appendJournal({
        at: at(1),
        type: 'letter.queued',
        job: 1,
        letter: 'a',
        agent: 'claude@demo',
      });
      store.appendJournal({ at: at(2), type: 'letter.queued', job: 2, letter: 'b' });

      const all = store.readJournal();
      expect(all.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(all[0]).toEqual({
        seq: 1,
        at: at(),
        type: 'job.created',
        job: 1,
        data: { title: 'x' },
      });
      expect(store.readJournal({ job: 1 }).map((entry) => entry.seq)).toEqual([1, 2]);
      expect(store.readJournal({ afterSeq: 1, limit: 1 }).map((entry) => entry.seq)).toEqual([2]);
      expect(store.readJournal({ tail: 2 }).map((entry) => entry.seq)).toEqual([2, 3]);
    });

    it('is append-only: an entry cannot be changed or removed', async () => {
      const { dir, remove } = tempDir();
      const path = join(dir, 'bridge.db');
      const file = await SqliteBridgeStore.open(path);
      file.appendJournal({ at: at(), type: 'job.created', job: 1 });
      file.close();

      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(path);
      try {
        expect(() => raw.prepare('UPDATE journal SET type = ?').run('x')).toThrow(/append-only/);
        expect(() => raw.prepare('DELETE FROM journal').run()).toThrow(/append-only/);
        expect(raw.prepare('SELECT COUNT(*) AS total FROM journal').get()).toEqual({ total: 1 });
      } finally {
        raw.close();
        remove();
      }
    });
  });

  describe('lease', () => {
    const candidate = (nonce: string, pid = 100) => ({
      pid,
      nonce,
      socket: '/tmp/s',
      version: '1',
    });
    const alive = () => true;

    it('goes to the first dispatcher and refuses the second while the first is alive', () => {
      const first = store.acquireLease(candidate('a'), { now: T0, ttlMs: 15_000, isAlive: alive });
      const second = store.acquireLease(candidate('b', 200), {
        now: T0 + 1_000,
        ttlMs: 15_000,
        isAlive: alive,
      });

      expect(first).toMatchObject({ acquired: true, lease: { nonce: 'a', heartbeatAt: T0 } });
      expect(second).toEqual({
        acquired: false,
        holder: expect.objectContaining({ nonce: 'a', pid: 100 }),
      });
    });

    it('is taken over from a holder whose process is gone', () => {
      store.acquireLease(candidate('a'), { now: T0, ttlMs: 15_000, isAlive: alive });
      const takeover = store.acquireLease(candidate('b', 200), {
        now: T0 + 1_000,
        ttlMs: 15_000,
        isAlive: (pid) => pid !== 100,
      });

      expect(takeover.acquired).toBe(true);
      expect(store.readLease()?.nonce).toBe('b');
    });

    it('is taken over from a holder whose heartbeat is too old', () => {
      store.acquireLease(candidate('a'), { now: T0, ttlMs: 15_000, isAlive: alive });
      store.renewLease('a', T0 + 10_000);

      const early = store.acquireLease(candidate('b', 200), {
        now: T0 + 25_000,
        ttlMs: 15_000,
        isAlive: alive,
      });
      const late = store.acquireLease(candidate('b', 200), {
        now: T0 + 25_001,
        ttlMs: 15_000,
        isAlive: alive,
      });

      expect(early.acquired).toBe(false);
      expect(late.acquired).toBe(true);
    });

    it('tells a holder that it lost the lease, and lets go only of its own', () => {
      store.acquireLease(candidate('a'), { now: T0, ttlMs: 15_000, isAlive: alive });
      store.acquireLease(candidate('b', 200), { now: T0 + 60_000, ttlMs: 15_000, isAlive: alive });

      expect(store.renewLease('a', T0 + 61_000)).toBe(false);
      expect(store.renewLease('b', T0 + 61_000)).toBe(true);
      store.releaseLease('a');
      expect(store.readLease()?.nonce).toBe('b');
      store.releaseLease('b');
      expect(store.readLease()).toBeUndefined();
    });
  });

  describe('transaction', () => {
    it('keeps everything the work wrote, across awaits', async () => {
      await store.transaction(async () => {
        store.insertLetter(letterInput({ id: 'a' }));
        await Promise.resolve();
        store.appendJournal({ at: at(), type: 'letter.queued', letter: 'a' });
      });

      expect(store.getLetter('a')).toBeDefined();
      expect(store.readJournal()).toHaveLength(1);
    });

    it('keeps nothing when the work throws', async () => {
      await expect(
        store.transaction(async () => {
          store.insertLetter(letterInput({ id: 'a' }));
          store.nextJobNumber();
          await Promise.resolve();
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(store.getLetter('a')).toBeUndefined();
      expect(store.nextJobNumber()).toBe(1);
    });

    it('does not nest', async () => {
      await expect(
        store.transaction(() => store.transaction(async () => undefined))
      ).rejects.toThrow(BridgeError);
      store.insertLetter(letterInput({ id: 'after' }));
      expect(store.getLetter('after')).toBeDefined();
    });
  });

  describe('files', () => {
    let dir: string;
    let remove: () => void;

    beforeEach(() => {
      ({ dir, remove } = tempDir());
    });

    afterEach(() => remove());

    it('creates the folder and the file for the owner only, and survives a reopen', async () => {
      const path = join(dir, 'nested', 'bridge.db');
      const first = await SqliteBridgeStore.open(path);
      first.insertLetter(letterInput());
      first.nextJobNumber();
      first.close();

      const second = await SqliteBridgeStore.open(path);
      try {
        expect(second.getLetter('ltr_1')?.body).toBe('Write the tests');
        expect(second.nextJobNumber()).toBe(2);
        second.appendJournal({ at: at(), type: 'job.created', job: 1 });
        if (process.platform !== 'win32') {
          expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
          expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
        }
      } finally {
        second.close();
      }
    });

    it('opens to read only while a writer has it open, and cannot write', async () => {
      const path = join(dir, 'bridge.db');
      const writer = await SqliteBridgeStore.open(path);
      writer.appendJournal({ at: at(), type: 'job.created', job: 1 });
      const reader = await SqliteBridgeStore.open(path, { readonly: true });
      try {
        expect(reader.readonly).toBe(true);
        expect(reader.readJournal()).toHaveLength(1);
        writer.appendJournal({ at: at(1), type: 'job.state', job: 1 });
        expect(reader.readJournal({ afterSeq: 1 })).toHaveLength(1);
        expect(() => reader.insertLetter(letterInput())).toThrow(/readonly|read-only|query_only/i);
      } finally {
        reader.close();
        writer.close();
      }
    });

    it('opens to read only after the writer closed', async () => {
      const path = join(dir, 'bridge.db');
      const writer = await SqliteBridgeStore.open(path);
      writer.appendJournal({ at: at(), type: 'job.created', job: 1 });
      writer.close();

      const reader = await SqliteBridgeStore.open(path, { readonly: true });
      try {
        expect(reader.readJournal()).toHaveLength(1);
      } finally {
        reader.close();
      }
    });

    it('keeps the database and its side files to the owner from the first write, in a folder others can enter', async () => {
      if (process.platform === 'win32') return;
      const open = join(dir, 'shared');
      mkdirSync(open, { mode: 0o755 });
      const path = join(open, 'bridge.db');

      const first = await SqliteBridgeStore.open(path);
      try {
        first.appendJournal({ at: at(), type: 'job.created', job: 1 });
        for (const file of [path, `${path}-wal`, `${path}-shm`]) {
          expect(statSync(file).mode & 0o777, file).toBe(0o600);
        }
      } finally {
        first.close();
      }
    });

    it('narrows a database that was left open to others', async () => {
      if (process.platform === 'win32') return;
      const path = join(dir, 'bridge.db');
      (await SqliteBridgeStore.open(path)).close();
      chmodSync(path, 0o644);

      const again = await SqliteBridgeStore.open(path);
      again.close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('refuses a database path that is not a plain file', async () => {
      if (process.platform === 'win32') return;
      const target = join(dir, 'elsewhere.db');
      writeFileSync(target, '');
      symlinkSync(target, join(dir, 'bridge.db'));

      await expect(SqliteBridgeStore.open(join(dir, 'bridge.db'))).rejects.toThrow(
        /not a plain file of this user/
      );
    });

    it('lets two processes open a fresh database at once', async () => {
      const path = join(dir, 'bridge.db');
      const opened = await Promise.all([
        SqliteBridgeStore.open(path),
        SqliteBridgeStore.open(path),
        SqliteBridgeStore.open(path),
      ]);
      try {
        opened[0].appendJournal({ at: at(), type: 'job.created', job: 1 });
        expect(opened[2].readJournal()).toHaveLength(1);
      } finally {
        for (const each of opened) each.close();
      }
    });

    it('does not create a database when asked to read one that is missing', async () => {
      await expect(
        SqliteBridgeStore.open(join(dir, 'missing.db'), { readonly: true })
      ).rejects.toMatchObject({ code: 'storage' });
    });

    /** Takes a database back to schema 1: what version 2 added is dropped. */
    async function asSchemaOne(path: string): Promise<void> {
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(path);
      raw.exec(`
        DROP INDEX letters_reply;
        DROP INDEX letters_person;
        ALTER TABLE letters DROP COLUMN ask;
        ALTER TABLE letters DROP COLUMN verdict;
        ALTER TABLE letters DROP COLUMN needs_person;
        ALTER TABLE letters DROP COLUMN person_asked_at;
        ALTER TABLE agents DROP COLUMN permission_mode;
      `);
      raw.pragma('user_version = 1');
      raw.close();
    }

    it('brings a database of an older schema up to date and keeps what it holds', async () => {
      const path = join(dir, 'bridge.db');
      const old = await SqliteBridgeStore.open(path);
      old.insertLetter(letterInput({ id: 'kept', inReplyTo: 'before' }));
      old.close();
      await asSchemaOne(path);

      const reader = await SqliteBridgeStore.open(path, { readonly: true });
      expect(reader.getLetter('kept')).toMatchObject({ id: 'kept', inReplyTo: 'before' });
      expect(reader.getLetter('kept')).not.toHaveProperty('needsPerson');
      reader.close();

      const upgraded = await SqliteBridgeStore.open(path);
      try {
        expect(upgraded.getLetter('kept')).toMatchObject({ id: 'kept', inReplyTo: 'before' });
        expect(upgraded.listLetters({ inReplyTo: 'before' })).toHaveLength(1);
        expect(upgraded.listLetters({ needsPerson: true })).toEqual([]);
        expect(
          upgraded.updateLetter('kept', { needsPerson: true, personAskedAt: at() })
        ).toMatchObject({ needsPerson: true });
      } finally {
        upgraded.close();
      }
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(path, { readonly: true });
      expect(raw.pragma('user_version', { simple: true })).toBe(BRIDGE_SCHEMA_VERSION);
      raw.close();
    });

    it('refuses a database written by a newer version', async () => {
      const path = join(dir, 'bridge.db');
      (await SqliteBridgeStore.open(path)).close();
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(path);
      raw.pragma(`user_version = ${BRIDGE_SCHEMA_VERSION + 1}`);
      raw.close();

      await expect(SqliteBridgeStore.open(path)).rejects.toThrow(/newer version/);
    });
  });
});
