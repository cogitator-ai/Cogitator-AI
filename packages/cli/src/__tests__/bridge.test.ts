import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  bridgePaths,
  hostBridge,
  type BridgeHost,
  type CallerIdentity,
  type JournalEntry,
} from '@cogitator-ai/bridge';
import {
  describeJournalEntry,
  formatJournalEntry,
  runBridgeLog,
  runBridgeServe,
  runBridgeStatus,
  type BridgeContext,
} from '../commands/bridge.js';
import { hostBridgeInDaemon } from '../utils/bridge-host.js';
import { createProgram } from '../program.js';

let home: string;
let lines: string[];
let warnings: string[];
let context: BridgeContext;
let stop: AbortController;
const hosts: BridgeHost[] = [];
const clients: BridgeClient[] = [];

const claude: CallerIdentity = {
  harness: 'claude-code',
  sessionId: 'session-claude',
  cwd: '/work/demo',
  project: '/work/demo',
};
const codex: CallerIdentity = {
  harness: 'codex',
  sessionId: 'thread-codex',
  cwd: '/work/demo',
  project: '/work/demo',
};

async function startHost(): Promise<BridgeHost> {
  const host = await hostBridge({ home, tickMs: 25 });
  hosts.push(host);
  return host;
}

async function clientFor(caller: CallerIdentity): Promise<BridgeClient> {
  const client = await BridgeClient.connect({ socketPath: bridgePaths({ home }).socket, caller });
  clients.push(client);
  return client;
}

/** A finished job between the two sessions, so the journal has something to tell */
async function exchange(): Promise<void> {
  const from = await clientFor(claude);
  const to = await clientFor(codex);
  await from.createJob({ to: 'codex', body: 'Write the tests for the rate limiter' });
  await to.inbox();
  await to.send({ job: 1, kind: 'report', body: 'Done: 14 tests pass' });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const output = () => lines.join('\n');

beforeEach(() => {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  home = mkdtempSync(join(base, 'cb-cli-'));
  lines = [];
  warnings = [];
  stop = new AbortController();
  context = {
    io: { print: (line) => lines.push(line), warn: (line) => warnings.push(line) },
    env: { COGITATOR_BRIDGE_HOME: home },
    signal: stop.signal,
    pollMs: 10,
  };
});

afterEach(async () => {
  stop.abort();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cogitator bridge log', () => {
  it('says there is nothing to read before any dispatcher ran', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runBridgeLog({}, context)).toBe(1);

    expect(error.mock.calls.flat().join(' ')).toContain('no journal yet');
    expect(error.mock.calls.flat().join(' ')).toContain('cogitator bridge serve');
    expect(existsSync(join(home, 'bridge.db'))).toBe(false);
  });

  it('prints the letters and what became of them, oldest first', async () => {
    await startHost();
    await exchange();

    expect(await runBridgeLog({}, context)).toBe(0);

    const text = output();
    expect(lines[0]).toMatch(/^-- \d{4}-\d{2}-\d{2} --$/);
    expect(text).toContain('claude@demo joined (claude-code)');
    expect(text).toContain(
      'job "Write the tests for the rate limiter" from claude@demo to codex@demo'
    );
    expect(text).toContain(
      'task from claude@demo to codex@demo: Write the tests for the rate limiter'
    );
    expect(text).toContain('job is working (was submitted)');
    expect(text).toContain('report from codex@demo to claude@demo: Done: 14 tests pass');
    expect(text).toContain('job is completed (was working)');
    expect(text.indexOf('job is working')).toBeLessThan(text.indexOf('job is completed'));
    expect(lines.filter((line) => line.includes('#1')).length).toBeGreaterThanOrEqual(6);
  });

  it('reads the journal after the dispatcher stopped', async () => {
    const host = await startHost();
    await exchange();
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await host.close();

    expect(await runBridgeLog({ job: 1 }, context)).toBe(0);
    expect(output()).toContain('job is completed');
    expect(output()).not.toContain('joined');
  });

  it('prints the last entries only, or one line of JSON per entry', async () => {
    await startHost();
    await exchange();

    await runBridgeLog({ lines: 2 }, context);
    expect(lines.filter((line) => !line.startsWith('--'))).toHaveLength(2);

    lines.length = 0;
    await runBridgeLog({ all: true, json: true }, context);
    const entries = lines.map((line) => JSON.parse(line) as JournalEntry);
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    expect(
      entries.some((entry) => entry.type === 'letter.queued' && entry.data?.kind === 'report')
    ).toBe(true);
  });

  it('says so when a job has no entries', async () => {
    await startHost();
    await runBridgeLog({ job: 42 }, context);
    expect(output()).toContain('Nothing about job 42');
  });

  it('keeps printing what comes in until it is stopped', async () => {
    await startHost();
    const from = await clientFor(claude);
    const to = await clientFor(codex);
    const following = runBridgeLog({ follow: true, job: 1 }, context);

    await from.createJob({ to: 'codex', body: 'Write the tests' });
    await until(() => output().includes('task from claude@demo'), 'the task to show');
    await to.send({ job: 1, kind: 'question', body: 'Mock Redis?' });
    await until(
      () => output().includes('question from codex@demo to claude@demo: Mock Redis?'),
      'the question'
    );

    stop.abort();
    expect(await following).toBe(0);
  });
});

describe('cogitator bridge status', () => {
  it('exits 1 and says how to start one when no dispatcher runs', async () => {
    expect(await runBridgeStatus({}, context)).toBe(1);
    expect(output()).toContain('No bridge dispatcher is running');
    expect(output()).toContain('cogitator bridge serve');
    expect(existsSync(join(home, 'bridge.db'))).toBe(false);
  });

  it('shows the dispatcher, its sessions and the jobs in progress', async () => {
    await startHost();
    const from = await clientFor(claude);
    await clientFor({ ...codex, sessionName: 'Reviewer' });
    await from.createJob({ to: 'codex', body: 'Write the tests' });

    expect(await runBridgeStatus({}, context)).toBe(0);

    const text = output();
    expect(text).toContain(`Bridge dispatcher running (pid ${process.pid}`);
    expect(text).toContain('Agents (2)');
    expect(text).toMatch(/codex@demo\s+codex "Reviewer", inbox/);
    expect(text).toContain('Jobs in progress (1), letters in the queue: 1');
    expect(text).toMatch(/#1\s+submitted\s+claude@demo -> codex@demo {2}Write the tests/);
    expect(text).toContain('none, sessions read their inbox themselves');
  });

  it('answers in JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await startHost();

    expect(await runBridgeStatus({ json: true }, context)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      running: true,
      home,
      agents: 0,
      activeJobs: 0,
      dispatcher: { pid: process.pid },
    });

    await hosts.pop()?.close();
    log.mockClear();
    expect(await runBridgeStatus({ json: true }, context)).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ running: false, home });
  });
});

describe('cogitator bridge serve', () => {
  it('runs the dispatcher until it is stopped, and leaves nothing behind', async () => {
    const serving = runBridgeServe({}, context);
    await until(() => output().includes('Bridge dispatcher running'), 'the dispatcher to start');

    const client = await clientFor(claude);
    expect(client.agent?.name).toBe('claude@demo');
    await client.close();
    clients.length = 0;

    stop.abort();
    expect(await serving).toBe(0);
    expect(output()).toContain('Bridge dispatcher stopped');
    if (process.platform !== 'win32') expect(existsSync(join(home, 'bridge.sock'))).toBe(false);
  });

  it('refuses to start a second one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await startHost();

    expect(await runBridgeServe({}, context)).toBe(1);

    const said = error.mock.calls.flat().join(' ');
    expect(said).toContain(`already running on this machine (pid ${process.pid})`);
    expect(said).toContain('cogitator bridge status');
  });
});

describe('journal lines', () => {
  const entry = (overrides: Partial<JournalEntry>): JournalEntry => ({
    seq: 1,
    at: '2026-11-15T10:00:00.000Z',
    type: 'job.state',
    ...overrides,
  });

  it('tell every kind of entry in words', () => {
    expect(
      describeJournalEntry(
        entry({
          type: 'agent.registered',
          agent: 'gemini@demo',
          data: { harness: 'gemini', started: true },
        })
      )
    ).toBe('gemini@demo joined (gemini, started by the bridge)');
    expect(
      describeJournalEntry(
        entry({ type: 'agent.gone', agent: 'gemini@demo', data: { error: 'not trusted' } })
      )
    ).toBe('gemini@demo is gone: not trusted');
    expect(
      describeJournalEntry(
        entry({ type: 'job.verified', data: { verified: false, summary: '2 of 14 fail' } })
      )
    ).toBe('checks did not confirm the result: 2 of 14 fail');
    expect(describeJournalEntry(entry({ type: 'job.verified', data: { verified: true } }))).toBe(
      'checks confirmed the result'
    );
    expect(
      describeJournalEntry(
        entry({ type: 'letter.delivered', agent: 'codex@demo', letter: 'ltr_1' })
      )
    ).toBe('delivered to codex@demo (ltr_1)');
    expect(
      describeJournalEntry(entry({ type: 'letter.read', agent: 'codex@demo', letter: 'ltr_1' }))
    ).toBe('read by codex@demo (ltr_1)');
    expect(
      describeJournalEntry(entry({ type: 'letter.handled', agent: 'codex@demo', letter: 'ltr_1' }))
    ).toBe('done with by codex@demo (ltr_1)');
    expect(
      describeJournalEntry(
        entry({
          type: 'letter.rejected',
          agent: 'codex@demo',
          data: { reason: 'loop_detected', kind: 'note' },
        })
      )
    ).toBe('refused a note of codex@demo: loop_detected');
    expect(
      describeJournalEntry(
        entry({ type: 'letter.rejected', agent: 'codex@demo', data: { reason: 'depth_exceeded' } })
      )
    ).toBe('refused a job of codex@demo: depth_exceeded');
    expect(
      describeJournalEntry(
        entry({
          type: 'letter.undelivered',
          agent: 'codex@demo',
          letter: 'ltr_1',
          data: { attempts: 5, error: 'busy' },
        })
      )
    ).toBe('could not deliver ltr_1 to codex@demo after 5 attempts: busy');
    expect(
      describeJournalEntry(
        entry({ type: 'letter.reminded', agent: 'claude@demo', letter: 'ltr_2' })
      )
    ).toBe('reminded claude@demo of ltr_2');
  });

  it('keep a long letter to one short line', () => {
    const line = formatJournalEntry(
      entry({
        type: 'letter.queued',
        job: 7,
        data: { kind: 'task', from: 'a', to: 'b', body: `First line\n${'x'.repeat(300)}` },
      })
    );

    expect(line).toContain('#7');
    expect(line).not.toContain('\n');
    expect(line.endsWith('...')).toBe(true);
  });
});

describe('the dispatcher inside the daemon', () => {
  const quiet = {
    info: (message: string) => lines.push(message),
    warn: (message: string) => warnings.push(message),
  };

  it('is hosted only when the daemon was started with --bridge', async () => {
    expect(await hostBridgeInDaemon({ COGITATOR_BRIDGE_HOME: home }, quiet)).toBeUndefined();
    expect(existsSync(join(home, 'bridge.db'))).toBe(false);

    const host = await hostBridgeInDaemon(
      { COGITATOR_BRIDGE_HOME: home, COGITATOR_BRIDGE_HOST: '1' },
      quiet
    );
    if (host) hosts.push(host);

    expect(host?.info.pid).toBe(process.pid);
    expect(output()).toContain('Bridge dispatcher hosted here');
  });

  it('leaves the assistant alone when a dispatcher already runs or cannot start', async () => {
    await startHost();
    const env = { COGITATOR_BRIDGE_HOME: home, COGITATOR_BRIDGE_HOST: '1' };

    expect(await hostBridgeInDaemon(env, quiet)).toBeUndefined();
    expect(output()).toContain('already running');
    expect(output()).toContain('this daemon does not host one');

    const broken = { ...env, COGITATOR_BRIDGE_HOME: `/tmp/${'x'.repeat(150)}` };
    expect(await hostBridgeInDaemon(broken, quiet)).toBeUndefined();
    expect(warnings.join(' ')).toContain('could not start');
  });
});

describe('the command line', () => {
  it('has bridge serve, status and log, and --bridge on the daemon', () => {
    const program = createProgram();
    const bridge = program.commands.find((command) => command.name() === 'bridge');
    const daemon = program.commands.find((command) => command.name() === 'daemon');

    expect(bridge?.commands.map((command) => command.name()).sort()).toEqual([
      'log',
      'serve',
      'status',
    ]);
    for (const name of ['start', 'restart', 'install']) {
      const sub = daemon?.commands.find((command) => command.name() === name);
      expect(sub?.options.map((option) => option.long)).toContain('--bridge');
    }
  });
});
