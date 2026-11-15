import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { bridgePaths } from '../paths';
import type { CallerIdentity } from '../types';
import { mailText, waitForMail } from '../waiter';
import { socketDir } from './helpers';

let home: string;
let removeHome: () => void;
let hosts: BridgeHost[];
let clients: BridgeClient[];
let errors: Error[];

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

async function startHost(): Promise<BridgeHost> {
  const host = await hostBridge({ home, tickMs: 25, onError: (error) => errors.push(error) });
  hosts.push(host);
  return host;
}

async function clientFor(caller: CallerIdentity): Promise<BridgeClient> {
  const client = await BridgeClient.connect({ socketPath: socket(), caller, timeoutMs: 5_000 });
  clients.push(client);
  return client;
}

const socket = () => bridgePaths({ home }).socket;

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  ({ dir: home, remove: removeHome } = socketDir());
  hosts = [];
  clients = [];
  errors = [];
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  for (const host of hosts) await host.close();
  removeHome();
});

describe('a process that waits for the mail of a session', () => {
  it('gets the letter the moment it is sent, and it counts as delivered once confirmed', async () => {
    const host = await startHost();
    const claude = await clientFor(claudeCaller);
    const waiting = waitForMail({ socketPath: socket(), caller: codexCaller, timeoutMs: 10_000 });
    await until(
      async () => (await host.dispatcher.status()).waiting.includes('codex@demo'),
      'the waiter to arm'
    );

    await claude.createJob({ to: 'codex', body: 'Write the tests' });
    const waited = await waiting;

    expect(waited.reason).toBe('letters');
    expect(mailText(waited.letters).split('\n')[1]).toBe('Write the tests');
    expect((await claude.letters({ job: 1 }))[0].state).toBe('queued');

    await waited.confirm();

    expect((await claude.letters({ job: 1 }))[0].state).toBe('delivered');
    expect((await claude.job(1)).state).toBe('working');
    expect(errors).toEqual([]);
  });

  it('joins several letters under their signatures, oldest first', async () => {
    await startHost();
    const claude = await clientFor(claudeCaller);
    await clientFor(codexCaller);
    await claude.createJob({ to: 'codex', body: 'Write the tests' });
    await claude.send({ job: 1, kind: 'note', body: 'Use vitest' });

    const waited = await waitForMail({
      socketPath: socket(),
      caller: codexCaller,
      timeoutMs: 5_000,
    });

    expect(mailText(waited.letters).split('\n')).toEqual([
      expect.stringContaining('| task from claude@demo to codex@demo |'),
      'Write the tests',
      '',
      expect.stringContaining('| note from claude@demo to codex@demo |'),
      'Use vitest',
    ]);
    await waited.confirm();
  });

  it('ends without mail when the time runs out', async () => {
    await startHost();
    const started = Date.now();

    const waited = await waitForMail({ socketPath: socket(), caller: codexCaller, timeoutMs: 150 });

    expect(waited).toMatchObject({ reason: 'timeout', letters: [] });
    expect(Date.now() - started).toBeLessThan(3_000);
    await waited.confirm();
  });

  it('waits for a dispatcher that is not running yet', async () => {
    const waiting = waitForMail({
      socketPath: socket(),
      caller: codexCaller,
      timeoutMs: 10_000,
      retryMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const host = await startHost();
    await until(
      async () => (await host.dispatcher.status()).waiting.includes('codex@demo'),
      'the waiter to find the dispatcher'
    );
    const claude = await clientFor(claudeCaller);
    await claude.createJob({ to: 'codex', body: 'Write the tests' });

    expect((await waiting).letters).toHaveLength(1);
  });

  it('stays through a restart of the dispatcher and gets what came meanwhile', async () => {
    const first = await startHost();
    const waiting = waitForMail({
      socketPath: socket(),
      caller: codexCaller,
      timeoutMs: 10_000,
      retryMs: 20,
    });
    await until(
      async () => (await first.dispatcher.status()).waiting.includes('codex@demo'),
      'the waiter to arm'
    );
    await first.close();

    const second = await startHost();
    await until(
      async () => (await second.dispatcher.status()).waiting.includes('codex@demo'),
      'the waiter to arm again'
    );
    const claude = await clientFor(claudeCaller);
    await claude.createJob({ to: 'codex', body: 'Write the tests' });

    const waited = await waiting;
    expect(waited.letters.map((letter) => letter.body)).toEqual(['Write the tests']);
    await waited.confirm();
    expect((await claude.letters({ job: 1 }))[0].state).toBe('delivered');
  });

  it('gives way to a newer waiter of the same session', async () => {
    const host = await startHost();
    const older = waitForMail({ socketPath: socket(), caller: codexCaller, timeoutMs: 10_000 });
    await until(
      async () => (await host.dispatcher.status()).waiting.includes('codex@demo'),
      'the first waiter to arm'
    );
    const stop = new AbortController();
    const newer = waitForMail({
      socketPath: socket(),
      caller: codexCaller,
      timeoutMs: 10_000,
      signal: stop.signal,
    });

    expect((await older).reason).toBe('replaced');
    expect((await host.dispatcher.status()).waiting).toEqual(['codex@demo']);

    stop.abort();
    expect((await newer).reason).toBe('closed');
    await until(
      async () => (await host.dispatcher.status()).waiting.length === 0,
      'the dispatcher to notice the waiter left'
    );
  });

  it('ends at once when it is told to stop while it still connects', async () => {
    await startHost();
    const stop = new AbortController();
    const started = Date.now();
    const waiting = waitForMail({
      socketPath: socket(),
      caller: codexCaller,
      timeoutMs: 20_000,
      signal: stop.signal,
    });
    await Promise.resolve();
    stop.abort();

    expect((await waiting).reason).toBe('closed');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('frees the session at the dispatcher when the waiting process is killed', async () => {
    const host = await startHost();
    const codex = await clientFor(codexCaller);
    const waiting = codex.wait({ timeoutMs: 10_000 }).catch((error: unknown) => error);
    await until(
      async () => (await host.dispatcher.status()).waiting.includes('codex@demo'),
      'the waiter to arm'
    );

    await codex.close();

    expect(await waiting).toMatchObject({ code: 'not_running' });
    await until(
      async () => (await host.dispatcher.status()).waiting.length === 0,
      'the dispatcher to drop the waiter'
    );
  });

  it('passes on what the dispatcher refuses the session for', async () => {
    await startHost();

    await expect(
      waitForMail({
        socketPath: socket(),
        caller: { ...codexCaller, cwd: 'relative/path' },
        timeoutMs: 1_000,
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
