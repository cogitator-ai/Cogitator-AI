import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeAdapter } from '../adapter';
import { claudeCodeAdapter, claudeWaitHook, hasClaudeWaitHook } from '../adapters/claude';
import { CODEX_ASLEEP_NOTE, codexAdapter } from '../adapters/codex';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { bridgePaths } from '../paths';
import { adapterConformanceCases, type AdapterConformanceTarget } from '../testing/conformance';
import { installFakeHarnesses, type FakeHarnesses } from '../testing/fake-harnesses';
import type { CallerIdentity } from '../types';
import { socketDir } from './helpers';

const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const WAIT = fileURLToPath(new URL('./fixtures/wait.ts', import.meta.url));
/** How the hook of a session reaches the bridge in these tests: the wait of the command line */
const BRIDGE_COMMAND = `${TSX} ${WAIT} bridge`;

const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let home: string;
let project: string;
let hosts: BridgeHost[];
let clients: BridgeClient[];
let errors: Error[];
const folders: (() => void)[] = [];

function folder(): string {
  const made = socketDir();
  folders.push(made.remove);
  return made.dir;
}

/** The environment of the harness commands: the fakes, and the bridge their hooks call back */
function env(bridgeHome = home): NodeJS.ProcessEnv {
  return fakes.env({ ...process.env, COGITATOR_BRIDGE_HOME: bridgeHome });
}

function claudeAdapter(options: Parameters<typeof claudeCodeAdapter>[0] = {}): BridgeAdapter {
  return claudeCodeAdapter({
    env: env(),
    bridgeCommand: BRIDGE_COMMAND,
    configPath: join(home, 'no-claude.json'),
    userSettingsPath: join(home, 'no-settings.json'),
    sessionListedMs: 10_000,
    ...options,
  });
}

function codex(options: Parameters<typeof codexAdapter>[0] = {}): BridgeAdapter {
  return codexAdapter({ env: env(), logDir: join(home, 'sessions'), ...options });
}

async function startHost(adapters: BridgeAdapter[]): Promise<BridgeHost> {
  const host = await hostBridge({
    home,
    adapters,
    tickMs: 50,
    onError: (error) => errors.push(error),
  });
  hosts.push(host);
  return host;
}

async function orchestrator(): Promise<BridgeClient> {
  const caller: CallerIdentity = {
    harness: 'conductor',
    sessionId: 'conductor-1',
    cwd: project,
    project,
  };
  const client = await BridgeClient.connect({ socketPath: bridgePaths({ home }).socket, caller });
  clients.push(client);
  return client;
}

async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string
): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  fakes = installFakeHarnesses();
  home = folder();
  project = folder();
  hosts = [];
  clients = [];
  errors = [];
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  for (const host of hosts) await host.close();
  await fakes.cleanup();
  for (const remove of folders.splice(0)) remove();
});

describe.skipIf(!posix)('the Claude Code adapter', () => {
  it('starts a background session with the first letter and the hook that wakes it', async () => {
    fakes.trustFolder(project);
    const host = await startHost([claudeAdapter({ permissionMode: 'acceptEdits' })]);
    const conductor = await orchestrator();

    const { job } = await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );

    const realProject = realpathSync(project);
    expect(agent).toMatchObject({ name: job.to, delivery: 'hook', cwd: realProject });
    const [session] = await fakes.claudeSessions();
    expect(session).toMatchObject({
      sessionId: agent.sessionId,
      kind: 'background',
      cwd: realProject,
    });
    const first = await fakes.waitForTurn('claude', agent.sessionId, () => true);
    expect(first.input.split('\n')).toEqual([
      expect.stringMatching(/^\[agent bridge\] job #1 "Review the diff" \| task from conductor@/),
      'Review the diff',
    ]);
    const [letter] = await conductor.letters({ job: 1 });
    expect(letter.state).toBe('delivered');
    expect((await conductor.job(1)).state).toBe('working');

    await until(
      async () => (await host.dispatcher.status()).waiting.includes(agent.name) || undefined,
      'the hook of the session to wait for mail'
    );
    expect(errors).toEqual([]);
  });

  it('wakes the session with a later letter, and the hook waits again after that turn', async () => {
    fakes.trustFolder(project);
    const host = await startHost([claudeAdapter()]);
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    await until(
      async () => (await host.dispatcher.status()).waiting.includes(agent.name) || undefined,
      'the hook to wait'
    );

    await conductor.send({ job: 1, kind: 'note', body: 'Skip the generated files' });

    const woken = await fakes.waitForTurn('claude', agent.sessionId, (turn) =>
      turn.input.includes('Skip the generated files')
    );
    expect(woken.wokenBy).toBe('hook');
    expect(woken.input.split('\n')[0]).toMatch(
      /\| note from conductor@.*\| not typed by the user$/
    );
    await until(
      async () =>
        (await conductor.letters({ job: 1, kinds: ['note'] }))[0].state === 'delivered' ||
        undefined,
      'the note to be confirmed'
    );
    await until(
      async () => (await host.dispatcher.status()).waiting.includes(agent.name) || undefined,
      'the hook to wait again'
    );

    await conductor.send({ job: 1, kind: 'note', body: 'And the lockfile' });
    await fakes.waitForTurn('claude', agent.sessionId, (turn) =>
      turn.input.includes('And the lockfile')
    );
    expect(errors).toEqual([]);
  });

  it('keeps one waiter when a person talks to the session while it waits', async () => {
    fakes.trustFolder(project);
    const host = await startHost([claudeAdapter()]);
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    await until(
      async () => (await host.dispatcher.status()).waiting.includes(agent.name) || undefined,
      'the hook to wait'
    );

    await fakes.say(agent.sessionId, 'say: still here');
    const typed = await fakes.waitForTurn(
      'claude',
      agent.sessionId,
      (turn) => turn.wokenBy === 'user'
    );
    expect(typed.answer).toBe('still here');
    await until(
      async () => (await host.dispatcher.status()).waiting.includes(agent.name) || undefined,
      'a hook to wait after the typed turn'
    );
    await conductor.send({ job: 1, kind: 'note', body: 'Skip the generated files' });
    await until(
      async () =>
        (await conductor.letters({ job: 1, kinds: ['note'] }))[0].state === 'delivered' ||
        undefined,
      'the note to be confirmed'
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const turns = fakes.transcript('claude', agent.sessionId);
    expect(turns.filter((turn) => turn.input.includes('Skip the generated files'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('wakes a session a person opened, once the project carries the hook', async () => {
    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify(claudeWaitHook({ bridgeCommand: BRIDGE_COMMAND }))
    );
    const host = await startHost([claudeAdapter()]);
    const sessionId = await fakes.openClaudeWindow({ cwd: project, env: env() });
    await fakes.say(sessionId, 'say: hello');
    await until(
      async () => (await host.dispatcher.status()).waiting.length === 1 || undefined,
      'the hook of the window to wait'
    );
    const [agent] = await host.dispatcher.agents({ harness: 'claude-code' });
    expect(agent).toMatchObject({ sessionId, delivery: 'hook' });

    const conductor = await orchestrator();
    const { job } = await conductor.createJob({ to: 'claude', body: 'Review the diff' });

    expect(job.to).toBe(agent.name);
    await fakes.waitForTurn('claude', sessionId, (turn) => turn.input.includes('Review the diff'));
    expect(await fakes.claudeSessions()).toHaveLength(1);
  });

  it('explains what to do when Claude Code does not trust the folder', async () => {
    await startHost([claudeAdapter()]);
    const conductor = await orchestrator();

    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const failed = await until(async () => {
      const job = await conductor.job(1);
      return job.state === 'failed' ? job : undefined;
    }, 'the job to fail');

    expect(failed.reason).toBe(
      `the bridge could not start a claude-code session: Claude Code does not trust ${realpathSync(project)} yet. ` +
        'Open the folder in Claude Code once and accept its trust prompt, then hand the job over again'
    );
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
  });

  it('checks the trust before it runs anything, when the record is there', async () => {
    fakes.trustFolder(project);
    const configPath = join(home, 'claude.json');
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { '/elsewhere': { hasTrustDialogAccepted: true } } })
    );
    await startHost([claudeAdapter({ configPath })]);
    const conductor = await orchestrator();

    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const failed = await until(async () => {
      const job = await conductor.job(1);
      return job.state === 'failed' ? job : undefined;
    }, 'the job to fail');

    expect(failed.reason).toContain(`Claude Code does not trust ${realpathSync(project)} yet`);
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
  });

  it('says what Claude Code said when the session does not start', async () => {
    fakes.trustFolder(project);
    const adapter = claudeAdapter({
      env: { ...env(), FAKE_CLAUDE_BG_FAIL: 'You have hit your usage limit' },
    });

    await expect(
      adapter.createSession?.({
        agentName: 'claude@demo',
        harness: 'claude-code',
        project,
        cwd: project,
        job: { number: 1 } as never,
        firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
      })
    ).rejects.toThrow('claude --bg failed: You have hit your usage limit');
  });

  it('lists the sessions that run, and none when Claude Code is not installed', async () => {
    const adapter = claudeAdapter();
    const window = await fakes.openClaudeWindow({ cwd: project, name: 'reviewer' });

    expect(await adapter.liveSessions?.()).toEqual([
      { sessionId: window, cwd: realpathSync(project), name: 'reviewer', busy: false },
    ]);
    const absent = claudeCodeAdapter({ env: { PATH: join(home, 'nothing') } });
    expect(await absent.liveSessions?.()).toEqual([]);
  });

  it('takes a session that stopped for gone and fails its job', async () => {
    fakes.trustFolder(project);
    const host = await hostBridge({
      home,
      adapters: [claudeAdapter()],
      tickMs: 30,
      limits: { presenceCheckMs: 30 },
      onError: (error) => errors.push(error),
    });
    hosts.push(host);
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    await until(
      async () => (await host.dispatcher.status()).waiting.includes(agent.name) || undefined,
      'the hook to wait'
    );

    await fakes.run('claude', ['stop', agent.sessionId]);

    const failed = await until(async () => {
      const job = await conductor.job(1);
      return job.state === 'failed' ? job : undefined;
    }, 'the job of the stopped session to fail');
    expect(failed.reason).toBe(`the session of ${agent.name} is not running any more`);
  });

  it('reports what doctor shows: the version, the commands, the trust and the hook', async () => {
    fakes.trustFolder(project);
    const configPath = join(home, 'claude.json');
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } })
    );
    const adapter = claudeAdapter({ configPath });

    const before = await adapter.health?.({ cwd: project });
    expect(before?.map((check) => [check.id, check.status])).toEqual([
      ['version', 'ok'],
      ['background', 'ok'],
      ['sessions', 'ok'],
      ['trust', 'ok'],
      ['hook', 'warn'],
    ]);
    expect(before?.[0].detail).toBe('2.1.292 (Claude Code)');
    const fix = before?.[4].fix ?? '';
    const snippet: unknown = JSON.parse(fix.slice(fix.indexOf('{')));
    expect(hasClaudeWaitHook(snippet)).toBe(true);

    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify(snippet));
    const after = await adapter.health?.({ cwd: project });
    expect(after?.[4]).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('settings.json'),
    });
    expect(after?.[4].fix).toBeUndefined();
  });

  it('looks for what Claude Code keeps where CLAUDE_CONFIG_DIR says', async () => {
    const configDir = join(home, 'claude-config');
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } })
    );
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(claudeWaitHook({ bridgeCommand: BRIDGE_COMMAND }))
    );
    const adapter = claudeCodeAdapter({ env: { ...env(), CLAUDE_CONFIG_DIR: configDir } });

    const checks = await adapter.health?.({ cwd: project });

    expect(checks?.find((check) => check.id === 'trust')?.status).toBe('ok');
    expect(checks?.find((check) => check.id === 'hook')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining(join(configDir, 'settings.json')),
    });
  });

  it('reports a version too old for the bridge, an untrusted folder, and a missing install', async () => {
    const old = claudeCodeAdapter({
      env: { ...env(), FAKE_CLAUDE_MISSING: 'bg,agents-json' },
      configPath: join(home, 'no-claude.json'),
    });
    const checks = await old.health?.({ cwd: project });
    expect(checks?.map((check) => [check.id, check.status])).toEqual([
      ['version', 'ok'],
      ['background', 'fail'],
      ['sessions', 'fail'],
      ['trust', 'warn'],
      ['hook', 'warn'],
    ]);
    expect(checks?.[1].fix).toBe('Update Claude Code: claude update');
    expect(checks?.[3].detail).toContain('could not read whether Claude Code trusts');

    const absent = claudeCodeAdapter({ env: { PATH: join(home, 'nothing') } });
    expect(await absent.health?.({ cwd: project })).toEqual([
      {
        id: 'version',
        title: 'Claude Code',
        status: 'fail',
        detail: 'claude is not installed, or not on PATH',
        fix: 'Install Claude Code: https://claude.com/claude-code',
      },
    ]);
  });
});

describe.skipIf(!posix)('the Codex adapter', () => {
  it('queues a letter for a thread open in the app, which wakes by itself', async () => {
    await fakes.startCodexApp();
    const threadId = await fakes.openCodexThread({ cwd: project });
    const host = await startHost([codex()]);
    const agent = await host.dispatcher.register({
      harness: 'codex',
      sessionId: threadId,
      cwd: project,
      project,
    });
    const conductor = await orchestrator();

    const { job } = await conductor.createJob({ to: 'codex', body: 'Write the tests' });

    expect(job.to).toBe(agent.name);
    const turn = await fakes.waitForTurn('codex', threadId, () => true);
    expect(turn.wokenBy).toBe('queue');
    expect(turn.input.split('\n')).toEqual([
      expect.stringMatching(/^\[agent bridge\] job #1 "Write the tests" \| task from conductor@/),
      'Write the tests',
    ]);
    const delivered = await until(
      async () =>
        (await conductor.readJournal({ job: 1 })).find(
          (entry) => entry.type === 'letter.delivered'
        ),
      'the delivery to be recorded'
    );
    expect(delivered.data).toBeUndefined();
    expect((await conductor.job(1)).state).toBe('working');
    expect(errors).toEqual([]);
  });

  it('says so in the journal when nothing will wake the thread', async () => {
    const threadId = await fakes.openCodexThread({ cwd: project, owner: 'none' });
    const host = await startHost([codex()]);
    await host.dispatcher.register({
      harness: 'codex',
      sessionId: threadId,
      cwd: project,
      project,
    });
    const conductor = await orchestrator();

    await conductor.createJob({ to: 'codex', body: 'Write the tests' });

    const delivered = await until(
      async () =>
        (await conductor.readJournal({ job: 1 })).find(
          (entry) => entry.type === 'letter.delivered'
        ),
      'the delivery to be recorded'
    );
    expect(delivered.data).toEqual({ note: CODEX_ASLEEP_NOTE });
    expect(fakes.transcript('codex', threadId)).toEqual([]);

    await fakes.startCodexDaemon();
    const turn = await fakes.waitForTurn('codex', threadId, () => true);
    expect(turn.input).toContain('Write the tests');
  });

  it('tries again when Codex refuses the letter, and gives up after the limit', async () => {
    const host = await hostBridge({
      home,
      adapters: [codex()],
      tickMs: 20,
      limits: { deliveryAttempts: 2, deliveryBackoffMs: 10, deliveryBackoffMaxMs: 10 },
      onError: (error) => errors.push(error),
    });
    hosts.push(host);
    await host.dispatcher.register({
      harness: 'codex',
      sessionId: 'no-such-thread',
      cwd: project,
      project,
    });
    const conductor = await orchestrator();

    await conductor.createJob({ to: 'codex', body: 'Write the tests' });

    const undelivered = await until(
      async () =>
        (await conductor.readJournal({ job: 1 })).find(
          (entry) => entry.type === 'letter.undelivered'
        ),
      'the bridge to give up'
    );
    expect(undelivered.data).toMatchObject({
      attempts: 2,
      error: "codex queue failed: Error: no session found for 'no-such-thread'",
    });
  });

  it('starts a thread for a job and leaves it to finish its turn', async () => {
    await startHost([codex({ sandbox: 'read-only' })]);
    const conductor = await orchestrator();

    const { job } = await conductor.createJob({
      to: 'codex',
      body: 'Write the tests\nrun: printf "%s|%s|%s" "$CODEX_THREAD_ID" "$COGITATOR_BRIDGE_AGENT" "$FAKE_CODEX_SANDBOX"\nsleep: 300',
    });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to start'
    );

    expect(agent.name).toBe(job.to);
    expect((await conductor.letters({ job: 1 }))[0].state).toBe('delivered');
    expect((await conductor.job(1)).state).toBe('working');
    const turn = await fakes.waitForTurn('codex', agent.sessionId, () => true);
    expect(turn.ran[0].stdout).toBe(`${agent.sessionId}|${agent.name}|read-only`);
    const [log] = readdirSync(join(home, 'sessions'));
    expect(log).toMatch(/^codex-codex_.*\.log$/);
    expect(readFileSync(join(home, 'sessions', log), 'utf8')).toContain('"type":"turn.completed"');
    expect(errors).toEqual([]);
  });

  it('does not hand a session the session id of the harness the dispatcher runs under', async () => {
    const adapter = codex({
      env: { ...env(), CLAUDE_CODE_SESSION_ID: 'the-orchestrator', CODEX_THREAD_ID: 'outer' },
    });
    await startHost([adapter]);
    const conductor = await orchestrator();

    await conductor.createJob({
      to: 'codex',
      body: 'run: printf "%s|%s|%s" "${CLAUDE_CODE_SESSION_ID:-none}" "$CODEX_THREAD_ID" "$COGITATOR_BRIDGE_HARNESS"',
    });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to start'
    );

    const turn = await fakes.waitForTurn('codex', agent.sessionId, () => true);
    expect(turn.ran[0].stdout).toBe(`none|${agent.sessionId}|codex`);
  });

  it('says what Codex said when the thread does not start, and when Codex is not installed', async () => {
    const request = {
      agentName: 'codex@demo',
      harness: 'codex',
      project,
      cwd: project,
      job: { number: 1 } as never,
      firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
    };
    const failing = codex({ env: { ...env(), FAKE_CODEX_EXEC_FAIL: 'Not logged in' } });
    await expect(failing.createSession?.(request)).rejects.toThrow(
      'codex exec ended before it started a thread: Not logged in'
    );

    const absent = codexAdapter({
      env: { PATH: join(home, 'nothing') },
      logDir: join(home, 'sessions'),
    });
    await expect(absent.createSession?.(request)).rejects.toThrow(
      'codex is not installed, or not on PATH'
    );
  });

  it('reports what doctor shows: the version, the commands and the daemon', async () => {
    const adapter = codex();

    const without = await adapter.health?.({ cwd: project });
    expect(without?.map((check) => [check.id, check.status])).toEqual([
      ['version', 'ok'],
      ['queue', 'ok'],
      ['exec', 'ok'],
      ['daemon', 'warn'],
    ]);
    expect(without?.[0].detail).toBe('codex-cli 0.167.0-alpha.4.1');
    expect(without?.[3].fix).toBe('codex app-server daemon start');

    await fakes.startCodexDaemon();
    expect((await adapter.health?.({ cwd: project }))?.[3]).toMatchObject({ status: 'ok' });
  });

  it('reports a version too old for the bridge, and a missing install', async () => {
    const old = codex({ env: { ...env(), FAKE_CODEX_MISSING: 'queue,exec-json' } });
    expect(
      (await old.health?.({ cwd: project }))?.map((check) => [check.id, check.status])
    ).toEqual([
      ['version', 'ok'],
      ['queue', 'fail'],
      ['exec', 'fail'],
      ['daemon', 'warn'],
    ]);

    const absent = codexAdapter({ env: { PATH: join(home, 'nothing') }, logDir: join(home, 's') });
    expect(await absent.health?.({ cwd: project })).toMatchObject([
      { id: 'version', status: 'fail', detail: 'codex is not installed, or not on PATH' },
    ]);
  });
});

describe.skipIf(!posix)('the adapter contract', () => {
  function target(
    harness: 'claude' | 'codex',
    create: AdapterConformanceTarget['create'],
    rest: Pick<AdapterConformanceTarget, 'supports' | 'processOf'>
  ): AdapterConformanceTarget {
    return {
      home: folder,
      get cwd() {
        fakes.trustFolder(project);
        return project;
      },
      create,
      received: async (sessionId, needle) => {
        await fakes.waitForTurn(harness, sessionId, (turn) => turn.input.includes(needle), {
          what: `a turn with "${needle}"`,
        });
      },
      ...rest,
    };
  }

  describe('kept by the Claude Code adapter', () => {
    const cases = adapterConformanceCases(
      target(
        'claude',
        (context) =>
          claudeCodeAdapter({
            env: env(context.home),
            bridgeCommand: BRIDGE_COMMAND,
            configPath: join(context.home, 'no-claude.json'),
            userSettingsPath: join(context.home, 'no-settings.json'),
          }),
        {
          supports: ['createSession', 'liveSessions', 'identify', 'health'],
          processOf: (sessionId) => ({
            env: {},
            cwd: project,
            hookInput: JSON.stringify({ session_id: sessionId, cwd: project }),
          }),
        }
      )
    );
    for (const conformance of cases) {
      it.skipIf(conformance.skip !== undefined)(conformance.name, () => conformance.run());
    }
  });

  describe('kept by the Codex adapter', () => {
    const cases = adapterConformanceCases(
      target(
        'codex',
        async (context) => {
          await fakes.startCodexDaemon();
          return codexAdapter({ env: env(context.home), logDir: join(context.home, 'sessions') });
        },
        {
          supports: ['createSession', 'identify', 'health'],
          processOf: (sessionId) => ({ env: { CODEX_THREAD_ID: sessionId }, cwd: project }),
        }
      )
    );
    for (const conformance of cases) {
      it.skipIf(conformance.skip !== undefined)(conformance.name, () => conformance.run());
    }
  });
});
