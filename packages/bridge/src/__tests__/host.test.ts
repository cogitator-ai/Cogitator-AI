import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { BridgeClient } from '../client';
import { BridgeError } from '../errors';
import { hostBridge, type BridgeHost } from '../host';
import { bridgePaths } from '../paths';
import { BRIDGE_PROTOCOL_VERSION } from '../protocol';
import { SqliteBridgeStore } from '../store/sqlite';
import type { CallerIdentity, JournalEntry } from '../types';
import { FakeAdapter } from './bridge-kit';
import { socketDir } from './helpers';

const posix = process.platform !== 'win32';

let home: string;
let removeHome: () => void;
const hosts: BridgeHost[] = [];
const clients: BridgeClient[] = [];
const errors: Error[] = [];

async function startHost(options: Parameters<typeof hostBridge>[0] = {}): Promise<BridgeHost> {
  const host = await hostBridge({
    home,
    tickMs: 25,
    onError: (error) => errors.push(error),
    ...options,
  });
  hosts.push(host);
  return host;
}

const claudeCaller: CallerIdentity = {
  harness: 'claude-code',
  sessionId: 'session-claude',
  cwd: '/work/demo',
  project: '/work/demo',
};
const codexCaller: CallerIdentity = {
  harness: 'codex',
  sessionId: 'thread-codex',
  cwd: '/work/demo',
  project: '/work/demo',
};

async function clientFor(caller?: CallerIdentity): Promise<BridgeClient> {
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home }).socket,
    ...(caller && { caller }),
    timeoutMs: 5_000,
  });
  clients.push(client);
  return client;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  ({ dir: home, remove: removeHome } = socketDir());
  errors.length = 0;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  removeHome();
});

describe('hostBridge', () => {
  it('serves two sessions a job from hand-over to report over the socket', async () => {
    const host = await startHost();
    const claude = await clientFor(claudeCaller);
    const codex = await clientFor(codexCaller);

    expect(claude.agent?.name).toBe('claude@demo');
    expect(claude.dispatcher).toMatchObject({
      pid: process.pid,
      protocol: BRIDGE_PROTOCOL_VERSION,
      socket: host.paths.socket,
      database: host.paths.database,
    });

    const { job } = await claude.createJob({ to: 'codex', body: 'Write the tests' });
    const [task] = await codex.inbox();
    expect(task.text).toContain('task from claude@demo to codex@demo');
    await codex.send({ job: job.number, kind: 'question', body: 'Mock Redis?' });
    expect((await claude.inbox())[0].body).toBe('Mock Redis?');
    await claude.send({ job: job.number, kind: 'answer', body: 'Yes' });
    await codex.send({ job: job.number, kind: 'report', body: 'Done' });

    expect(await claude.job(job.number)).toMatchObject({ state: 'completed', lettersUsed: 4 });
    expect((await claude.jobs({ states: ['completed'] })).map((found) => found.number)).toEqual([
      1,
    ]);
    expect((await claude.agents({ harness: 'codex' })).map((agent) => agent.name)).toEqual([
      'codex@demo',
    ]);
    expect((await claude.letters({ job: 1, kinds: ['report'] }))[0].outcome).toBe('completed');
    expect(await claude.status()).toMatchObject({
      agents: 2,
      activeJobs: 0,
      queuedLetters: 2,
      dispatcher: { pid: process.pid },
    });
    expect(errors).toEqual([]);
  });

  it('keeps the socket and the database to the owner', async () => {
    const host = await startHost();
    if (!posix) return;

    expect(statSync(host.paths.socket).mode & 0o777).toBe(0o600);
    expect(statSync(host.paths.database).mode & 0o777).toBe(0o600);
  });

  it('refuses a second dispatcher while the first runs, naming it', async () => {
    await startHost();

    const second = await hostBridge({ home }).catch((error: unknown) => error);

    expect(second).toBeInstanceOf(BridgeError);
    expect(second).toMatchObject({
      code: 'already_running',
      data: { holder: { pid: process.pid } },
    });
    expect((second as BridgeError).message).toContain(`pid ${process.pid}`);
    const client = await clientFor();
    expect((await client.status()).dispatcher.pid).toBe(process.pid);
  });

  it('lets the next dispatcher in after it closed, with everything still there', async () => {
    const first = await startHost();
    const claude = await clientFor(claudeCaller);
    await clientFor(codexCaller);
    await claude.createJob({ to: 'codex', body: 'Write the tests' });
    await first.close();
    expect(await first.stopped).toBe('closed');
    if (posix) expect(existsSync(first.paths.socket)).toBe(false);
    await until(() => claude.closed, 'the client to notice');

    await startHost();
    const codex = await clientFor(codexCaller);

    expect(codex.agent?.name).toBe('codex@demo');
    expect(await codex.inbox()).toMatchObject([{ kind: 'task', body: 'Write the tests' }]);
    expect((await codex.job(1)).state).toBe('working');
  });

  it('delivers what waited in the queue once a dispatcher with an adapter starts', async () => {
    const first = await startHost();
    const claude = await clientFor(claudeCaller);
    await clientFor(codexCaller);
    await claude.createJob({ to: 'codex', body: 'Write the tests' });
    await first.close();

    const adapter = new FakeAdapter();
    await startHost({ adapters: [adapter] });
    await (await clientFor(codexCaller)).status();

    await until(() => adapter.delivered.length === 1, 'the queued letter to be delivered');
    expect(adapter.delivered[0].letter.body).toBe('Write the tests');
  });

  it('takes over from a dispatcher whose process is gone', async () => {
    const paths = bridgePaths({ home });
    const store = await SqliteBridgeStore.open(paths.database);
    store.acquireLease(
      { pid: 2_147_483_646, nonce: 'dead', socket: paths.socket, version: '0' },
      { now: Date.now(), ttlMs: 60_000, isAlive: () => true }
    );
    store.close();

    const host = await startHost();

    expect(host.info.pid).toBe(process.pid);
    expect((await (await clientFor()).status()).dispatcher.pid).toBe(process.pid);
  });

  it('stops when another dispatcher took the store over, and writes nothing more', async () => {
    const host = await startHost({ tickMs: 10_000 });
    const claude = await clientFor(claudeCaller);
    await clientFor(codexCaller);
    const store = await SqliteBridgeStore.open(host.paths.database);
    store.acquireLease(
      { pid: process.pid, nonce: 'usurper', socket: host.paths.socket, version: '0' },
      { now: Date.now(), ttlMs: 60_000, isAlive: () => false }
    );

    await expect(claude.createJob({ to: 'codex', body: 'Write the tests' })).rejects.toMatchObject({
      code: 'not_running',
    });

    expect(await host.stopped).toBe('lost');
    expect(store.jobTasks()).toEqual([]);
    expect(store.readLease()?.nonce).toBe('usurper');
    if (posix) expect(existsSync(host.paths.socket)).toBe(true);
    store.close();
  });

  it('notices on its next tick that it was replaced', async () => {
    const host = await startHost({ tickMs: 15 });
    const store = await SqliteBridgeStore.open(host.paths.database);
    store.acquireLease(
      { pid: process.pid, nonce: 'usurper', socket: host.paths.socket, version: '0' },
      { now: Date.now(), ttlMs: 60_000, isAlive: () => false }
    );

    expect(await host.stopped).toBe('lost');
    expect(errors.map((error) => error.message)).toContain(
      'Another bridge dispatcher took over, this one stops'
    );
    store.close();
  });

  it('fails jobs past their time on its own clock', async () => {
    await startHost({ tickMs: 10 });
    const claude = await clientFor(claudeCaller);
    await clientFor(codexCaller);
    await claude.createJob({ to: 'codex', body: 'Write the tests', budget: { durationMs: 30 } });

    await until(async () => (await claude.job(1)).state === 'failed', 'the job to run out of time');
    expect((await claude.job(1)).reason).toMatch(/ran longer than its/);
  });
});

describe('BridgeClient', () => {
  it('says so when no dispatcher runs', async () => {
    await expect(clientFor()).rejects.toMatchObject({ code: 'not_running' });
    await expect(clientFor()).rejects.toThrow(/cogitator bridge serve/);
  });

  it('reads without a session, and cannot act as an agent', async () => {
    await startHost();
    const reader = await clientFor();

    expect(reader.agent).toBeUndefined();
    expect(await reader.jobs()).toEqual([]);
    await expect(reader.createJob({ to: 'codex', body: 'x' })).rejects.toMatchObject({
      code: 'not_registered',
    });
    await expect(reader.inbox()).rejects.toMatchObject({ code: 'not_registered' });
  });

  it('gets the refusals of the bridge as BridgeError, with their code and data', async () => {
    await startHost();
    const claude = await clientFor(claudeCaller);

    const error = await claude
      .createJob({ to: 'codex', body: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'no_session', data: { harness: 'codex', sessions: [] } });
    await expect(claude.job(7)).rejects.toMatchObject({ code: 'unknown_job', data: { job: 7 } });
    await expect(claude.acknowledge('nope')).rejects.toMatchObject({ code: 'unknown_letter' });
    await expect(claude.cancel(7)).rejects.toMatchObject({ code: 'unknown_job' });
    await expect(claude.recordVerification(7, { verified: true })).rejects.toMatchObject({
      code: 'unknown_job',
    });
  });

  it('hears the journal as it grows, of one job or of all', async () => {
    await startHost();
    const claude = await clientFor(claudeCaller);
    const codex = await clientFor(codexCaller);
    const watcher = await clientFor();
    const all: JournalEntry[] = [];
    const second: JournalEntry[] = [];
    const secondWatcher = await clientFor();
    const stopAll = await watcher.subscribe((entry) => all.push(entry));
    await secondWatcher.subscribe((entry) => second.push(entry), { job: 2 });

    await claude.createJob({ to: 'codex', body: 'First' });
    await claude.createJob({ to: 'codex', body: 'Second' });
    await codex.inbox();
    await until(() => all.length >= 8 && second.length >= 4, 'the journal entries to arrive');

    expect(all.map((entry) => entry.type).slice(0, 4)).toEqual([
      'job.created',
      'letter.queued',
      'job.created',
      'letter.queued',
    ]);
    expect(new Set(second.map((entry) => entry.job))).toEqual(new Set([2]));
    expect(all.map((entry) => entry.seq)).toEqual(
      (await watcher.readJournal()).slice(-all.length).map((entry) => entry.seq)
    );

    await stopAll();
    const heard = all.length;
    await codex.send({ job: 1, kind: 'report', body: 'Done' });
    await until(async () => (await watcher.job(1)).state === 'completed', 'the report');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(all.length).toBe(heard);
  });

  it('rejects the calls still waiting when the dispatcher goes away', async () => {
    const host = await startHost();
    const claude = await clientFor(claudeCaller);

    const waiting = claude.status().catch((error: unknown) => error);
    await host.close();

    await until(() => claude.closed, 'the client to notice');
    await waiting;
    await expect(claude.status()).rejects.toMatchObject({ code: 'not_running' });
  });

  it('is refused by a dispatcher that speaks an older protocol', async () => {
    const host = await startHost();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(host.paths.socket);
      socket.once('error', reject);
      socket.once('data', (chunk) => {
        resolve(chunk.toString('utf-8'));
        socket.destroy();
      });
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bridge/hello', params: { protocol: BRIDGE_PROTOCOL_VERSION + 1 } })}\n`
      );
    });

    expect(JSON.parse(answer)).toMatchObject({
      id: 1,
      error: { code: -32001, data: { code: 'invalid_input' } },
    });
  });

  it('answers a line that is not JSON and a method it does not have, and keeps the connection', async () => {
    const host = await startHost();
    const lines = await new Promise<string[]>((resolve, reject) => {
      const socket = connect(host.paths.socket);
      let buffer = '';
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const got = buffer.split('\n').filter(Boolean);
        if (got.length === 3) {
          resolve(got);
          socket.destroy();
        }
      });
      socket.write('this is not json\n');
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope/nothing' })}\n`);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'bridge/status' })}\n`);
    });
    const byId = new Map(
      lines
        .map((line) => JSON.parse(line) as { id: number | null })
        .map((message) => [message.id, message])
    );

    expect(byId.get(null)).toMatchObject({ error: { code: -32700 } });
    expect(byId.get(2)).toMatchObject({ error: { code: -32601 } });
    expect(byId.get(3)).toMatchObject({ result: { dispatcher: { pid: process.pid } } });
  });
});
