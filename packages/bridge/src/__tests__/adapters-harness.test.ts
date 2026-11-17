import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeAdapter } from '../adapter';
import {
  CLAUDE_TOOLS_PERMISSION,
  claudeCodeAdapter,
  claudePermitHook,
  claudeStuckHook,
  claudeToolsHook,
  claudeWaitHook,
} from '../adapters/claude';
import { CODEX_NOT_RESUMED_NOTE, codexAdapter, codexReportNotice } from '../adapters/codex';
import type { ToolsServerCommand } from '../adapters/tools-server';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { bridgePaths } from '../paths';
import { adapterConformanceCases, type AdapterConformanceTarget } from '../testing/conformance';
import { installFakeHarnesses, type FakeHarnesses } from '../testing/fake-harnesses';
import type { CallerIdentity } from '../types';
import { socketDir } from './helpers';

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const WAIT = fileURLToPath(new URL('./fixtures/wait.ts', import.meta.url));
/** How the hook of a session reaches the bridge in these tests: the wait of the command line */
const BRIDGE_COMMAND = `${process.execPath} --import ${TSX} ${WAIT} bridge`;
const TOOLS_SERVER = fileURLToPath(new URL('./fixtures/tools-server.ts', import.meta.url));
/** What a command of a session does to reach the bridge's socket, as its command line would */
const CONNECT =
  "require('node:net').connect(process.argv[1]).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (error) => { console.log(error.code); process.exit(3); })";

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

/** Makes `dir` a git repository with one commit. */
function gitInit(dir: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
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

/** How a session starts the bridge's server of tools in these tests, for the bridge in `home` */
function toolsServer(): ToolsServerCommand {
  return { command: process.execPath, args: ['--import', TSX, TOOLS_SERVER, '--home', home] };
}

const connecting = (): string =>
  `run: ${process.execPath} -e ${JSON.stringify(CONNECT)} ${JSON.stringify(bridgePaths({ home }).socket)}`;

async function startHost(
  adapters: BridgeAdapter[],
  more: Pick<Parameters<typeof hostBridge>[0] & object, 'rights' | 'person'> = {}
): Promise<BridgeHost> {
  const host = await hostBridge({
    home,
    adapters,
    tickMs: 50,
    onError: (error) => errors.push(error),
    ...more,
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
  const deadline = Date.now() + 30_000;
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
  vi.restoreAllMocks();
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
    expect(agent.sessionName).toBeUndefined();
    const [session] = await fakes.claudeSessions();
    expect(session.name).toBe('[agent-bridge]-job');
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
    const waits = vi.spyOn(host.dispatcher, 'wait');
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    await until(() => waits.mock.calls.length === 1 || undefined, 'the first hook to wait');

    await fakes.say(agent.sessionId, 'say: still here');
    const typed = await fakes.waitForTurn(
      'claude',
      agent.sessionId,
      (turn) => turn.wokenBy === 'user'
    );
    expect(typed.answer).toBe('still here');
    await until(() => waits.mock.calls.length === 2 || undefined, 'the hook of the typed turn');

    expect(await waits.mock.results[0].value).toEqual({ letters: [], reason: 'replaced' });
    expect((await host.dispatcher.status()).waiting).toEqual([agent.name]);

    await conductor.send({ job: 1, kind: 'note', body: 'Skip the generated files' });
    await until(() => waits.mock.calls.length === 3 || undefined, 'the hook after the woken turn');

    expect(await waits.mock.results[1].value).toMatchObject({ reason: 'letters' });
    const turns = fakes.transcript('claude', agent.sessionId);
    expect(turns.filter((turn) => turn.input.includes('Skip the generated files'))).toHaveLength(1);
    expect(turns.map((turn) => turn.wokenBy)).toEqual(['prompt', 'user', 'hook']);
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

  it('tells the sessions it starts which bridge to call when it is not the default one', async () => {
    fakes.trustFolder(project);
    await startHost([claudeAdapter()]);
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'claude', body: 'Review the diff' });
    await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );

    const [session] = await fakes.claudeSessions();
    const record = JSON.parse(
      readFileSync(join(fakes.home, 'claude', 'sessions', `${session.sessionId}.json`), 'utf8')
    ) as { settings?: unknown };
    expect(JSON.stringify(record.settings)).toContain(`--home ${home}`);
    expect(JSON.stringify(claudeWaitHook())).not.toContain('--home');
  });

  it('hands a session a notice for a first letter too long for an argument, then the letter itself', async () => {
    fakes.trustFolder(project);
    const host = await startHost([claudeAdapter()]);
    const conductor = await orchestrator();
    const long = `Review this:\n${'x'.repeat(130_000)}\nTHE END OF THE LETTER`;

    await conductor.createJob({ to: 'claude', title: 'A long one', body: long });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );

    const first = await fakes.waitForTurn('claude', agent.sessionId, () => true);
    expect(first.input.split('\n')).toEqual([
      expect.stringMatching(/^\[agent bridge\] job #1 "A long one" \| task from conductor@/),
      expect.stringMatching(
        new RegExp(
          `^This letter is ${long.length} characters long, too long to hand over here\\. Read it from the bridge: .* bridge inbox --job 1 --home `
        )
      ),
    ]);
    const whole = await fakes.waitForTurn('claude', agent.sessionId, (turn) =>
      turn.input.includes('THE END OF THE LETTER')
    );
    expect(whole.wokenBy).toBe('hook');
    await until(
      async () => (await conductor.letters({ job: 1 }))[0].state === 'delivered' || undefined,
      'the letter to be confirmed'
    );
    expect((await host.dispatcher.job(1)).state).toBe('working');
  });

  it('stops a background session that never shows up among the running ones', async () => {
    const calls = join(home, 'calls.log');
    const stub = join(home, 'claude-stub');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        `echo "$*" >> "${calls}"`,
        'case "$1" in',
        '  --bg) echo "backgrounded · deadbeef · stub" ;;',
        '  agents) echo "[]" ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    const adapter = claudeAdapter({ command: stub, sessionListedMs: 300 });

    await expect(
      adapter.createSession?.({
        agentName: 'claude@demo',
        harness: 'claude-code',
        project,
        cwd: project,
        job: { number: 1 } as never,
        firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
      })
    ).rejects.toThrow(
      'Claude Code started the background session deadbeef, but it never showed up in claude agents --json'
    );

    const ran = readFileSync(calls, 'utf8').trim().split('\n');
    expect(ran[0]).toMatch(/^--bg --settings /);
    expect(ran.at(-1)).toBe('stop deadbeef');
  });

  it('says so when Claude Code cannot list its sessions', async () => {
    const stub = join(home, 'claude-broken');
    writeFileSync(stub, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n', { mode: 0o755 });

    await expect(claudeAdapter({ command: stub }).liveSessions?.()).rejects.toThrow(
      'claude agents --json failed: not logged in'
    );
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

  it('says so when the session it started died before its first turn', async () => {
    fakes.trustFolder(project);
    const adapter = claudeAdapter({ sessionArgs: ['--mcp-config', 'no-such-servers.json'] });

    await expect(
      adapter.createSession?.({
        agentName: 'claude@demo',
        harness: 'claude-code',
        project,
        cwd: project,
        job: { number: 1 } as never,
        firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
      })
    ).rejects.toThrow(
      /^Claude Code started the background session [0-9a-f]{8}, and it failed before its first turn$/
    );
  });

  it('lists the sessions whose process is alive, and none when Claude Code is not installed', async () => {
    const adapter = claudeAdapter();
    const window = await fakes.openClaudeWindow({ cwd: project, name: 'reviewer' });

    expect(await adapter.liveSessions?.()).toEqual([
      { sessionId: window, cwd: realpathSync(project), name: 'reviewer', busy: false },
    ]);
    await fakes.run('claude', ['stop', window]);
    expect(await fakes.claudeSessions({ all: true })).toHaveLength(1);
    expect(await adapter.liveSessions?.()).toEqual([]);

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
      ['tools', 'warn'],
    ]);
    expect(before?.[0].detail).toBe('2.1.292 (Claude Code)');
    expect(before?.[4].fix).toBe('cogitator bridge install claude');
    expect(before?.[5].fix).toBe('cogitator bridge install claude');

    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify(claudeWaitHook({ bridgeCommand: BRIDGE_COMMAND }))
    );
    const after = await adapter.health?.({ cwd: project });
    expect(after?.[4]).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('settings.json'),
    });
    expect(after?.[4].fix).toBeUndefined();
  });

  it('reports whether the sessions of a folder have the tools, and the hook that names them', async () => {
    const adapter = claudeCodeAdapter({ env: env(), userSettingsPath: join(home, 'none.json') });
    const tools = async () =>
      (await adapter.health?.({ cwd: project }))?.filter((check) =>
        ['tools', 'caller'].includes(check.id)
      );
    expect(await tools()).toMatchObject([{ id: 'tools', status: 'warn' }]);

    const added = await fakes.run(
      'claude',
      ['mcp', 'add', '--scope', 'local', 'bridge', '--', 'node', '/x/cli.js', 'bridge', 'mcp'],
      { cwd: project }
    );
    expect(added.code).toBe(0);
    expect(await tools()).toMatchObject([
      { id: 'tools', status: 'ok', detail: expect.stringContaining('local config') },
      {
        id: 'caller',
        status: 'warn',
        detail: expect.stringContaining('after /clear'),
        fix: 'cogitator bridge install claude',
      },
    ]);

    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify(claudeToolsHook({ bridgeCommand: BRIDGE_COMMAND }))
    );
    expect(await tools()).toMatchObject([
      { id: 'tools', status: 'ok' },
      { id: 'caller', status: 'ok', detail: expect.stringContaining('settings.local.json') },
    ]);

    await fakes.run('claude', ['mcp', 'remove', 'bridge'], { cwd: project });
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { bridge: { command: 'node' } } })
    );
    expect((await tools())?.[0]).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('project config'),
    });
  });

  it('gives a session it starts the tools, the hook that names it and the permission to call them', async () => {
    fakes.trustFolder(project);
    await startHost([claudeAdapter({ toolsServer: toolsServer() })]);
    const conductor = await orchestrator();

    await conductor.createJob({
      to: 'claude',
      body: 'Review the diff\ntool: bridge.report {"job":1,"result":"Two findings, both in limiter.ts"}\nsay: Reported',
    });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    const turn = await fakes.waitForTurn('claude', agent.sessionId, () => true);

    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]).toMatchObject({ tool: 'bridge.report', isError: false });
    expect(turn.tools[0].text).toContain('Job #1 is completed');
    expect(turn.tools[0].sent).toMatchObject({
      job: 1,
      _bridge: { harness: 'claude-code', session: agent.sessionId, cwd: realpathSync(project) },
    });
    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report of the session');
    expect(report).toMatchObject({
      kind: 'report',
      from: agent.name,
      body: 'Two findings, both in limiter.ts',
    });
    expect(await conductor.agents({ harness: 'claude-code' })).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('has a session it starts ask leave through the bridge for a call no rule of its own settles', async () => {
    fakes.trustFolder(project);
    await startHost([claudeAdapter()], { rights: () => 'allow' });
    const conductor = await orchestrator();

    await conductor.createJob({
      to: 'claude',
      body: 'Ship the fix\nbash: echo pushed\nbash: echo forced\nsay: Shipped',
    });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    const requestOf = (command: string) =>
      until(async () => {
        const asked = await conductor.inbox();
        return asked.find((letter) => letter.ask?.command === command);
      }, `the request for ${command}`);

    const first = await requestOf('echo pushed');
    expect(first).toMatchObject({
      kind: 'permission',
      from: agent.name,
      body: `Run in ${realpathSync(project)}:\necho pushed`,
      ask: { tool: 'Bash', access: 'command', command: 'echo pushed', cwd: realpathSync(project) },
    });
    expect((await conductor.job(1)).state).toBe('input-required');
    expect((await conductor.agents({ harness: 'claude-code' }))[0].permissionMode).toBe(
      'acceptEdits'
    );
    await conductor.send({ job: 1, kind: 'answer', body: 'Go', verdict: 'allow' });
    await requestOf('echo forced');
    await conductor.send({ job: 1, kind: 'answer', body: 'Never forced', verdict: 'deny' });
    const turn = await fakes.waitForTurn('claude', agent.sessionId, () => true);

    expect(turn.ran.map((run) => [run.command, run.code, run.stdout || run.stderr])).toEqual([
      ['echo pushed', 0, 'pushed\n'],
      ['echo forced', null, 'Refused by conductor@' + agent.name.split('@')[1] + ': Never forced'],
    ]);
    expect(turn.answer).toBe('Shipped');
    expect((await fakes.claudeSessions())[0]).not.toHaveProperty('waitingFor');
    expect(errors).toEqual([]);
  });

  it('lets a session it starts change files in the folder of its job, and asks leave for one outside', async () => {
    fakes.trustFolder(project);
    const asked: string[][] = [];
    await startHost([claudeAdapter()], {
      rights: ({ ask }) => {
        asked.push(ask.paths ?? []);
        return 'deny';
      },
    });
    const conductor = await orchestrator();
    const outside = join(home, 'elsewhere.txt');

    await conductor.createJob({
      to: 'claude',
      body: `Write the notes\nedit: notes/a.txt\nedit: ${outside}\nsay: Written`,
    });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    const turn = await fakes.waitForTurn('claude', agent.sessionId, () => true);

    expect(turn.ran.map((run) => [run.command, run.code])).toEqual([
      ['edit notes/a.txt', 0],
      [`edit ${outside}`, null],
    ]);
    expect(turn.ran[1].stderr).toMatch(
      /^Refused by bridge: The rules of conductor@\S+ forbid this/
    );
    expect(readFileSync(join(project, 'notes', 'a.txt'), 'utf8')).toBe('edited\n');
    expect(existsSync(outside)).toBe(false);
    expect(asked).toEqual([[outside]]);
    expect((await conductor.agents({ harness: 'claude-code' }))[0].permissionMode).toBe(
      'acceptEdits'
    );
    expect(errors).toEqual([]);
  });

  it('has a session it starts change the files of the job in place, not in a worktree of Claude Code', async () => {
    gitInit(project);
    fakes.trustFolder(project);
    await startHost([claudeAdapter()]);
    const conductor = await orchestrator();

    await conductor.createJob({ to: 'claude', body: 'Write the notes\nedit: notes/a.txt' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    const turn = await fakes.waitForTurn('claude', agent.sessionId, () => true);

    expect(turn.ran.map((run) => [run.command, run.code])).toEqual([['edit notes/a.txt', 0]]);
    expect(readFileSync(join(project, 'notes', 'a.txt'), 'utf8')).toBe('edited\n');
    expect(existsSync(join(project, '.claude', 'worktrees'))).toBe(false);
    expect(errors).toEqual([]);
  });

  it('starts a session in the worktree of its job, and brings what it changed there back', async () => {
    gitInit(project);
    fakes.trustFolder(project);
    await startHost([claudeAdapter({ toolsServer: toolsServer() })], { rights: () => 'allow' });
    const conductor = await orchestrator();

    const { job } = await conductor.createJob({
      to: 'claude',
      title: 'Write the notes',
      body: 'Write the notes\nrun: pwd\nedit: notes/a.txt\ntool: bridge.report {"job":1,"result":"Written"}',
      worktree: true,
      checks: [{ command: 'test -f notes/a.txt' }],
    });
    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report of the session');

    const worktree = join(
      realpathSync(project),
      '.cogitator',
      'worktrees',
      'job-1-write-the-notes'
    );
    const done = await conductor.job(job.number);
    expect(done).toMatchObject({
      state: 'completed',
      cwd: worktree,
      worktree: { path: worktree, branch: 'cogitator/job-1-write-the-notes' },
      changes: { files: 1, insertions: 1, paths: ['notes/a.txt'] },
      verification: { verified: true },
    });
    const [agent] = await conductor.agents({ harness: 'claude-code' });
    const turn = await fakes.waitForTurn('claude', agent.sessionId, () => true);
    expect(turn.ran[0]).toMatchObject({ command: 'pwd', stdout: `${worktree}\n` });
    expect(turn.input).toContain(
      `[agent bridge] You work in a git worktree of your own: ${worktree}`
    );
    expect(report.text).toContain('[agent bridge] Changed in the worktree of the job');
    expect(report.text).toContain('[agent bridge] Checks. Verified: the check passed.');
    expect(existsSync(join(project, 'notes'))).toBe(false);
    expect(existsSync(join(project, '.claude', 'worktrees'))).toBe(false);

    const taken = await conductor.accept({ job: job.number });

    expect(taken).toMatchObject({ state: 'accepted', files: 1 });
    expect(readFileSync(join(project, 'notes', 'a.txt'), 'utf8')).toBe('edited\n');
    expect(existsSync(worktree)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('leaves the dialog to the person when its session carries out no job of the bridge', async () => {
    await startHost([claudeAdapter()], { rights: () => 'allow' });
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify(claudePermitHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home }))
    );
    const sessionId = await fakes.openClaudeWindow({ cwd: project, env: env() });

    await fakes.say(sessionId, 'bash: echo mine');
    await until(
      async () =>
        (await fakes.claudeSessions()).find((session) => session.sessionId === sessionId)
          ?.waitingFor === 'permission prompt' || undefined,
      'the dialog of the person'
    );
    await fakes.answerPermission(sessionId, 'allow');

    expect((await fakes.waitForTurn('claude', sessionId, () => true)).ran[0]).toMatchObject({
      code: 0,
      stdout: 'mine\n',
    });
    expect(errors).toEqual([]);
  });

  it('tells whoever handed a job to a window a person opened that it waits for them at its dialog', async () => {
    await startHost([claudeAdapter()]);
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          ...claudeWaitHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home }).hooks,
          ...claudeStuckHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home }).hooks,
        },
      })
    );
    const sessionId = await fakes.openClaudeWindow({ cwd: project, env: env() });
    await fakes.say(sessionId, 'say: here');
    await fakes.waitForTurn('claude', sessionId, () => true);
    const conductor = await orchestrator();
    const window = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the window to be known'
    );

    await conductor.createJob({
      to: window.name,
      body: 'Ship the fix\nbash: echo pushed\nsay: Shipped',
    });
    const note = await until(async () => {
      const mail = await conductor.inbox();
      return mail.find((letter) => letter.kind === 'note');
    }, 'the note that the window waits');

    expect(note.body.split('\n')).toEqual([
      `${window.name} waits for a person at its own window, and job #1 stands still until they answer there. It shows:`,
      '> Claude needs your permission',
      'Nobody can answer that from here. If the user is with you, tell them in one line.',
    ]);
    await fakes.answerPermission(sessionId, 'allow');
    const turn = await fakes.waitForTurn('claude', sessionId, (done) => done.answer === 'Shipped');
    expect(turn.ran[0]).toMatchObject({ code: 0, stdout: 'pushed\n' });
    expect(errors).toEqual([]);
  });

  it('starts a session without the tools when it was given no server for them', async () => {
    fakes.trustFolder(project);
    await startHost([claudeAdapter()]);
    const conductor = await orchestrator();

    await conductor.createJob({ to: 'claude', body: 'Review the diff\ntool: bridge.jobs' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the session to start'
    );
    const turn = await fakes.waitForTurn('claude', agent.sessionId, () => true);

    expect(turn.tools[0]).toMatchObject({ isError: true, text: 'No MCP server named "bridge"' });
    const record = JSON.parse(
      readFileSync(join(fakes.home, 'claude', 'sessions', `${agent.sessionId}.json`), 'utf8')
    ) as { settings: string; mcpConfig?: string };
    expect(record.mcpConfig).toBeUndefined();
    expect(JSON.parse(record.settings)).not.toHaveProperty('permissions');
    expect(record.settings).not.toContain(CLAUDE_TOOLS_PERMISSION);
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
      ['tools', 'warn'],
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
    expect(delivered.data).toEqual({ note: CODEX_NOT_RESUMED_NOTE });
    expect((await conductor.job(1)).state).toBe('working');
    expect(errors).toEqual([]);
  });

  it('queues a notice for a letter too long for an argument, and the letter stays in the inbox', async () => {
    await fakes.startCodexApp();
    const threadId = await fakes.openCodexThread({ cwd: project });
    const host = await startHost([codex({ bridgeCommand: 'node /opt/cli.js bridge' })]);
    const agent = await host.dispatcher.register({
      harness: 'codex',
      sessionId: threadId,
      cwd: project,
      project,
    });
    const conductor = await orchestrator();
    const long = `Port this:\n${'y'.repeat(130_000)}`;

    await conductor.createJob({ to: 'codex', title: 'A long one', body: long });

    const turn = await fakes.waitForTurn('codex', threadId, () => true);
    expect(turn.input.split('\n')[1]).toBe(
      `This letter is ${long.length} characters long, too long to hand over here. Read it from the bridge: node /opt/cli.js bridge inbox --job 1 --home ${home}`
    );
    const [inbox] = await host.dispatcher.inbox(agent.name);
    expect(inbox.body).toBe(long);
  });

  it('says so in the journal when no daemon is there to resume the thread', async () => {
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
    expect(delivered.data).toEqual({ note: CODEX_NOT_RESUMED_NOTE });
    expect(fakes.transcript('codex', threadId)).toEqual([]);

    await fakes.startCodexDaemon();
    const turn = await fakes.waitForTurn('codex', threadId, () => true);
    expect(turn.input).toContain('Write the tests');

    await conductor.send({ job: 1, kind: 'note', body: 'Skip the generated files' });
    await fakes.waitForTurn('codex', threadId, (next) => next.input.includes('Skip the generated'));
    const deliveries = await until(async () => {
      const entries = await conductor.readJournal({ job: 1 });
      const found = entries.filter((entry) => entry.type === 'letter.delivered');
      return found.length === 2 ? found : undefined;
    }, 'both deliveries to be recorded');
    expect(deliveries.map((entry) => entry.data)).toEqual([
      { note: CODEX_NOT_RESUMED_NOTE },
      undefined,
    ]);
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

  it('starts a thread for a job, and reports its final answer when its turn ends without a report', async () => {
    await startHost([codex({ sandbox: 'read-only' })]);
    const conductor = await orchestrator();

    const { job } = await conductor.createJob({
      to: 'codex',
      body: 'Write the tests\nrun: printf "%s|%s|%s" "$CODEX_THREAD_ID" "$COGITATOR_BRIDGE_AGENT" "$FAKE_CODEX_SANDBOX"\nsleep: 1000\nsay: 14 tests written',
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
    expect(turn.input.split('\n').slice(-2)).toEqual(['', codexReportNotice(1)]);
    const [log] = readdirSync(join(home, 'sessions'));
    expect(log).toMatch(/^codex-codex_.*\.log$/);
    await until(
      () =>
        readFileSync(join(home, 'sessions', log), 'utf8').includes('"type":"turn.completed"') ||
        undefined,
      'the thread to finish its turn by itself'
    );

    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report for the thread');
    expect(report).toMatchObject({
      kind: 'report',
      from: agent.name,
      body: '14 tests written',
      outcome: 'completed',
    });
    expect((await conductor.job(1)).state).toBe('completed');
    expect(errors).toEqual([]);
  });

  it('leaves the report to a thread that sends one itself', async () => {
    const host = await startHost([codex()]);
    const looked = vi.spyOn(host.dispatcher, 'job');
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'codex', body: 'Write the tests\nsleep: 1500\nsay: All good' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to start'
    );

    await host.dispatcher.send(agent.name, { job: 1, kind: 'report', body: 'Done: 14 tests pass' });
    await fakes.waitForTurn('codex', agent.sessionId, () => true);
    await until(
      () => looked.mock.results.length > 0 || undefined,
      'the adapter to look at the job'
    );
    await looked.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reports = await conductor.letters({ job: 1, kinds: ['report'] });
    expect(reports.map((letter) => letter.body)).toEqual(['Done: 14 tests pass']);
    expect(errors).toEqual([]);
  });

  it('reports nothing for a thread that asked a question and waits for the answer', async () => {
    const host = await startHost([codex()]);
    const read = vi.spyOn(host.dispatcher, 'letters');
    const conductor = await orchestrator();
    await conductor.createJob({ to: 'codex', body: 'Write the tests\nsleep: 1500\nsay: Waiting' });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to start'
    );

    await host.dispatcher.send(agent.name, { job: 1, kind: 'question', body: 'Mock Redis?' });
    await fakes.waitForTurn('codex', agent.sessionId, () => true);
    await until(
      () => read.mock.results.length > 0 || undefined,
      'the adapter to look at the letters'
    );
    await read.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await conductor.letters({ job: 1, kinds: ['report'] })).toEqual([]);
    expect((await conductor.job(1)).state).toBe('input-required');
    expect(errors).toEqual([]);
  });

  it('fails the job with what Codex said when the turn of its thread fails', async () => {
    await startHost([
      codex({ env: { ...env(), FAKE_CODEX_TURN_FAIL: 'Error: usage limit reached' } }),
    ]);
    const conductor = await orchestrator();

    const { job } = await conductor.createJob({ to: 'codex', body: 'Write the tests' });

    const failed = await until(async () => {
      const current = await conductor.job(1);
      return current.state === 'failed' ? current : undefined;
    }, 'the job to fail');
    expect(failed.to).toBe(job.to);
    const [report] = await conductor.letters({ job: 1, kinds: ['report'] });
    expect(report).toMatchObject({
      from: job.to,
      body: 'codex exec failed before the thread finished its turn: Error: usage limit reached',
      outcome: 'failed',
    });
    expect(errors).toEqual([]);
  });

  it('stops a thread it never learned the id of, so it does not work on unseen', async () => {
    const stalled = join(home, 'stalled-codex');
    writeFileSync(stalled, `#!/bin/sh\necho $$ > "${join(home, 'stalled.pid')}"\nexec sleep 30\n`, {
      mode: 0o755,
    });
    const adapter = codexAdapter({
      command: stalled,
      env: env(),
      logDir: join(home, 'sessions'),
      threadStartedMs: 300,
    });

    await expect(
      adapter.createSession?.({
        agentName: 'codex@demo',
        harness: 'codex',
        project,
        cwd: project,
        job: { number: 1 } as never,
        firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
      })
    ).rejects.toThrow('codex exec did not say which thread it started');

    const pid = Number(readFileSync(join(home, 'stalled.pid'), 'utf8'));
    await until(() => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 'the stalled process to be stopped');
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

  it('says a thread wakes for its mail only while the local daemon runs', async () => {
    const adapter = codex();
    const threadId = await fakes.openCodexThread({ cwd: project, owner: 'none' });
    const host = await startHost([adapter]);
    const thread = await host.dispatcher.register({
      harness: 'codex',
      sessionId: threadId,
      cwd: project,
      project,
    });
    expect(await host.dispatcher.wakes(thread.name)).toBe(false);
    await fakes.startCodexDaemon();
    expect(await host.dispatcher.wakes(thread.name)).toBe(true);
    expect(await host.dispatcher.wakes('nobody@nowhere')).toBe(false);
  });

  it('reports what doctor shows: the version, the commands and the daemon', async () => {
    const adapter = codex();

    const without = await adapter.health?.({ cwd: project });
    expect(without?.map((check) => [check.id, check.status])).toEqual([
      ['version', 'ok'],
      ['queue', 'ok'],
      ['exec', 'ok'],
      ['daemon', 'warn'],
      ['tools', 'warn'],
    ]);
    expect(without?.[0].detail).toBe('codex-cli 0.167.0-alpha.4.1');
    expect(without?.[3].fix).toBe('codex app-server daemon start');
    expect(without?.[4].fix).toBe('cogitator bridge install codex');

    await fakes.startCodexDaemon();
    await fakes.run('codex', ['mcp', 'add', 'bridge', '--', 'node', '/x/cli.js', 'bridge', 'mcp']);
    const set = await adapter.health?.({ cwd: project });
    expect(set?.[3]).toMatchObject({ status: 'ok' });
    expect(set?.[4]).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('any sandbox'),
    });
    expect(set?.[4].fix).toBeUndefined();
  });

  it('gives a thread it starts the tools, which reach the bridge from a sandbox its commands cannot leave', async () => {
    await startHost([codex({ sandbox: 'workspace-write', toolsServer: toolsServer() })]);
    const conductor = await orchestrator();
    const outside = join(home, 'written-by-the-thread.txt');

    const { job } = await conductor.createJob({
      to: 'codex',
      body: [
        'Write the tests',
        connecting(),
        `run: ${process.execPath} -e "require('node:fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(outside)}`,
        'tool: bridge.report {"job":1,"result":"14 tests written, all pass"}',
        'say: This is not the report',
      ].join('\n'),
    });
    const agent = await until(
      async () => (await conductor.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to start'
    );
    const turn = await fakes.waitForTurn('codex', agent.sessionId, () => true);

    expect(turn.ran.map((run) => [run.code, run.stdout])).toEqual([
      [3, 'EPERM\n'],
      [1, ''],
    ]);
    expect(existsSync(outside)).toBe(false);
    expect(turn.tools[0]).toMatchObject({ tool: 'bridge.report', isError: false });
    expect(turn.input.split('\n').at(-1)).toBe(codexReportNotice(1, true));
    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report of the thread');
    expect(report).toMatchObject({
      kind: 'report',
      from: job.to,
      body: '14 tests written, all pass',
      outcome: 'completed',
    });
    expect(agent.name).toBe(job.to);
    const [log] = readdirSync(join(home, 'sessions'));
    await until(
      () =>
        readFileSync(join(home, 'sessions', log), 'utf8').includes('"type":"turn.completed"') ||
        undefined,
      'the thread to finish its turn'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reports = await conductor.letters({ job: 1, kinds: ['report'] });
    expect(reports.map((letter) => letter.body)).toEqual(['14 tests written, all pass']);
    expect(await conductor.agents({ harness: 'codex' })).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('lets a thread ask with the tools, wake for the answer and report', async () => {
    await fakes.startCodexDaemon();
    await startHost([codex({ sandbox: 'read-only', toolsServer: toolsServer() })]);
    const conductor = await orchestrator();

    await conductor.createJob({
      to: 'codex',
      body: 'Write the tests\ntool: bridge.ask {"job":1,"question":"Mock Redis or run a real one?"}\nsay: Asked',
    });
    const [question] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the question of the thread');
    expect(question).toMatchObject({ kind: 'question', body: 'Mock Redis or run a real one?' });
    expect((await conductor.job(1)).state).toBe('input-required');

    await conductor.send({
      job: 1,
      kind: 'answer',
      body: 'Mock it\ntool: bridge.report {"job":1,"result":"Done with a mock"}',
    });

    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report of the thread');
    expect(report).toMatchObject({ kind: 'report', body: 'Done with a mock' });
    expect((await conductor.job(1)).state).toBe('completed');
    expect(await conductor.letters({ job: 1, kinds: ['report'] })).toHaveLength(1);
    expect(errors).toEqual([]);
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
      ['tools', 'warn'],
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
