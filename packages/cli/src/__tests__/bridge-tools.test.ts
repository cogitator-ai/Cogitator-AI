import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  CommandMissingError,
  bridgePaths,
  claudeCodeAdapter,
  codexAdapter,
  hostBridge,
  type AdapterSetup,
  type BridgeAdapter,
  type BridgeHost,
  type SetupStep,
} from '@cogitator-ai/bridge';
import { BRIDGE_NOTES_START } from '@cogitator-ai/bridge/tools';
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';
import {
  runBridgeInstall,
  runBridgeUninstall,
  type BridgeInstallContext,
} from '../commands/bridge-install.js';
import { TOOLS_REPLY_HINT, runBridgeWait } from '../commands/bridge-session.js';
import {
  BRIDGE_SERVER_NAME,
  createBridgeMcpServer,
  runBridgeCaller,
  runBridgePermit,
  runBridgeStuck,
  type BridgeCallerContext,
} from '../commands/bridge-tools.js';
import {
  bridgeAdapters,
  bridgeHomeOf,
  bridgeSetups,
  bridgeToolsServerOf,
} from '../utils/bridge-adapters.js';
import { exitCodeFor } from '../utils/cli.js';

let bridgeDir: string;
let project: string;
let lines: string[];
let failures: string[];
const hosts: BridgeHost[] = [];

const output = () => stripVTControlCharacters(lines.join('\n'));
const failed = () => stripVTControlCharacters(failures.join('\n'));

beforeEach(() => {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  bridgeDir = mkdtempSync(join(base, 'cb-cli-'));
  project = mkdtempSync(join(base, 'cb-proj-'));
  lines = [];
  failures = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    failures.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const folder of [bridgeDir, project]) rmSync(folder, { recursive: true, force: true });
});

describe('bridge mcp', () => {
  it('serves the tools of the bridge', () => {
    const server = createBridgeMcpServer({ home: bridgeDir, env: {} });

    expect(server.getRegisteredTools()).toEqual([
      'delegate',
      'build',
      'review',
      'race',
      'debate',
      'ask',
      'answer',
      'report',
      'note',
      'inbox',
      'job',
      'jobs',
      'cancel',
      'diff',
      'accept',
      'reject',
      'remember',
      'recall',
      'forget',
      'agents',
      'suggest',
    ]);
    expect(BRIDGE_SERVER_NAME).toBe('cogitator-bridge');
  });

  it('is started the way this process was, with the folder of the bridge when it is not the default', () => {
    const [script] = process.argv.slice(1);

    expect(bridgeToolsServerOf({})).toEqual({
      command: process.execPath,
      args: [script, 'bridge', 'mcp'],
    });
    expect(bridgeToolsServerOf({}, '/srv/bridge').args.slice(-2)).toEqual([
      '--home',
      '/srv/bridge',
    ]);
    expect(
      bridgeToolsServerOf({ COGITATOR_BRIDGE_COMMAND: 'my-cogitator bridge' }, '/srv/my bridge')
    ).toEqual({
      command: 'sh',
      args: ['-c', "exec my-cogitator bridge mcp --home '/srv/my bridge'"],
    });
  });

  it('is told a folder of the bridge that a flag or the environment names', () => {
    expect(bridgeHomeOf({})).toBeUndefined();
    expect(bridgeHomeOf({ COGITATOR_BRIDGE_HOME: ' /srv/bridge ' })).toBe('/srv/bridge');
    expect(bridgeHomeOf({ COGITATOR_BRIDGE_HOME: '/srv/bridge' }, '/tmp/other')).toBe('/tmp/other');
  });
});

describe('bridge permit', () => {
  const hookInput = (command: string) =>
    JSON.stringify({
      session_id: 'worker-1',
      cwd: project,
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command, description: 'Push the branch' },
    });

  function hook(input: string | undefined, extra: Partial<BridgeCallerContext> = {}) {
    const written: string[] = [];
    const context: BridgeCallerContext = {
      write: (text) => written.push(text),
      env: { COGITATOR_BRIDGE_HOME: bridgeDir },
      cwd: project,
      stdin: async () => input,
      adapters: [claudeCodeAdapter(), codexAdapter()],
      ...extra,
    };
    return { context, written };
  }

  /** A dispatcher, a conductor, and a Claude Code session that carries a job of it out. */
  async function working(rights: 'allow' | 'deny') {
    const host = await hostBridge({ home: bridgeDir, tickMs: 25, rights: () => rights });
    hosts.push(host);
    const connect = (harness: string, sessionId: string) =>
      BridgeClient.connect({
        socketPath: bridgePaths({ home: bridgeDir }).socket,
        caller: { harness, sessionId, cwd: project },
      });
    const conductor = await connect('conductor', 'conductor-1');
    const worker = await connect('claude-code', 'worker-1');
    const { job } = await conductor.createJob({ to: 'claude', body: 'Ship the fix' });
    await worker.inbox();
    await worker.close();
    return { conductor, job };
  }

  it('takes the call to the bridge and answers Claude Code with the verdict', async () => {
    const { conductor, job } = await working('allow');
    try {
      const allowed = hook(hookInput('git push origin main'));
      const running = runBridgePermit({ hook: 'claude-code', timeout: 20 }, allowed.context);
      const request = await vi.waitFor(async () => {
        const [letter] = await conductor.inbox();
        expect(letter).toBeDefined();
        return letter;
      });
      expect(request).toMatchObject({
        kind: 'permission',
        body: `Push the branch\nRun in ${project}:\ngit push origin main`,
        ask: { tool: 'Bash', access: 'command', command: 'git push origin main', cwd: project },
      });
      await conductor.send({ job: job.number, kind: 'answer', body: 'Go', verdict: 'allow' });

      expect(await running).toBe(0);
      expect(JSON.parse(allowed.written.join(''))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
    } finally {
      await conductor.close();
    }
  });

  it('belongs to the job a session was started for, even before the bridge has learned its id', async () => {
    let started: (session: { sessionId: string }) => void = () => undefined;
    const starting: BridgeAdapter = {
      harness: 'claude-code',
      delivery: 'test',
      capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
      createSession: () => new Promise((resolve) => (started = resolve)),
      deliver: async () => undefined,
    };
    const host = await hostBridge({
      home: bridgeDir,
      tickMs: 25,
      adapters: [starting],
      rights: () => 'allow',
    });
    hosts.push(host);
    const conductor = await BridgeClient.connect({
      socketPath: bridgePaths({ home: bridgeDir }).socket,
      caller: { harness: 'conductor', sessionId: 'conductor-1', cwd: project },
    });
    try {
      const { job } = await conductor.createJob({ to: 'claude', body: 'Ship the fix' });
      const first = hook(hookInput('git push origin main'));

      const running = runBridgePermit(
        { hook: 'claude-code', timeout: 20, agent: job.to },
        first.context
      );
      const request = await vi.waitFor(async () => {
        const [letter] = await conductor.inbox();
        expect(letter).toBeDefined();
        return letter;
      });
      expect(request).toMatchObject({ kind: 'permission', from: job.to });
      await conductor.send({ job: job.number, kind: 'answer', body: 'Go', verdict: 'allow' });

      expect(await running).toBe(0);
      expect(JSON.parse(first.written.join('')).hookSpecificOutput.decision).toEqual({
        behavior: 'allow',
      });
      expect(
        (await conductor.agents({ harness: 'claude-code' })).map((agent) => agent.name)
      ).toEqual([job.to]);
      started({ sessionId: 'worker-1' });
    } finally {
      await conductor.close();
    }
  });

  it('answers with the refusal and who refused, the bridge itself included', async () => {
    const { conductor } = await working('deny');
    try {
      const refused = hook(hookInput('rm -rf build'));

      expect(await runBridgePermit({ hook: 'claude-code', timeout: 20 }, refused.context)).toBe(0);

      expect(JSON.parse(refused.written.join(''))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: expect.stringMatching(
              /^Refused by bridge: The rules of conductor@\S+ forbid this, so it is refused$/
            ),
          },
        },
      });
    } finally {
      await conductor.close();
    }
  });

  it('takes its request back when nobody decided in time, and leaves the dialog to Claude Code', async () => {
    const { conductor, job } = await working('allow');
    try {
      const late = hook(hookInput('git push origin main'));

      expect(await runBridgePermit({ hook: 'claude-code', timeout: 1 }, late.context)).toBe(0);

      expect(late.written).toEqual([]);
      expect(await conductor.inbox()).toEqual([]);
      expect((await conductor.job(job.number)).state).toBe('working');
      await expect(
        conductor.send({ job: job.number, kind: 'answer', body: 'Go', verdict: 'allow' })
      ).rejects.toThrow(expect.objectContaining({ code: 'invalid_letter' }));
    } finally {
      await conductor.close();
    }
  });

  it("answers nothing, and leaves the dialog to Claude Code, when the call is not the bridge's to ask about", async () => {
    const noDispatcher = hook(hookInput('git push'));
    expect(await runBridgePermit({ hook: 'claude-code' }, noDispatcher.context)).toBe(0);
    expect(noDispatcher.written).toEqual([]);

    const host = await hostBridge({ home: bridgeDir, tickMs: 25 });
    hosts.push(host);
    for (const input of [undefined, 'not json', JSON.stringify({ session_id: 'x' })]) {
      const other = hook(input);
      expect(await runBridgePermit({ hook: 'claude-code' }, other.context)).toBe(0);
      expect(other.written).toEqual([]);
    }
    const noJob = hook(hookInput('git push'));
    expect(await runBridgePermit({ hook: 'claude-code' }, noJob.context)).toBe(0);
    expect(noJob.written).toEqual([]);
  });

  it('never exits with the code a harness reads as a refusal, whatever goes wrong', async () => {
    const codexHook = hook(hookInput('git push'));
    expect(await runBridgePermit({ hook: 'codex' }, codexHook.context)).toBe(1);
    expect(codexHook.written).toEqual([]);
    expect(failed()).toContain('No adapter asks leave for the sessions of "codex"');
  });
});

describe('bridge stuck', () => {
  const notification = (type: string) =>
    JSON.stringify({
      session_id: 'worker-1',
      cwd: project,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
      notification_type: type,
    });

  function hook(input: string | undefined) {
    const written: string[] = [];
    const context: BridgeCallerContext = {
      write: (text) => written.push(text),
      env: { COGITATOR_BRIDGE_HOME: bridgeDir },
      cwd: project,
      stdin: async () => input,
      adapters: [claudeCodeAdapter(), codexAdapter()],
    };
    return { context, written };
  }

  it('tells whoever handed the session a job that it waits for a person, and says nothing to Claude Code', async () => {
    const host = await hostBridge({ home: bridgeDir, tickMs: 25 });
    hosts.push(host);
    const connect = (harness: string, sessionId: string) =>
      BridgeClient.connect({
        socketPath: bridgePaths({ home: bridgeDir }).socket,
        caller: { harness, sessionId, cwd: project },
      });
    const conductor = await connect('conductor', 'conductor-1');
    const worker = await connect('claude-code', 'worker-1');
    try {
      await conductor.createJob({ to: 'claude', body: 'Ship the fix' });
      await worker.inbox();
      const idle = hook(notification('idle_prompt'));
      const prompt = hook(notification('permission_prompt'));

      expect(await runBridgeStuck({ hook: 'claude-code' }, idle.context)).toBe(0);
      expect(await conductor.inbox()).toEqual([]);
      expect(await runBridgeStuck({ hook: 'claude-code' }, prompt.context)).toBe(0);

      const [note] = await conductor.inbox();
      expect(note.body).toContain('> Claude needs your permission to use Bash');
      expect(prompt.written).toEqual([]);
    } finally {
      await conductor.close();
      await worker.close();
    }
  });

  it('is quiet without a dispatcher, and never exits with the code a harness reads as a refusal', async () => {
    const alone = hook(notification('permission_prompt'));
    expect(await runBridgeStuck({ hook: 'claude-code' }, alone.context)).toBe(0);
    expect(failed()).toBe('');

    const codexHook = hook(notification('permission_prompt'));
    expect(await runBridgeStuck({ hook: 'codex' }, codexHook.context)).toBe(1);
    expect(failed()).toContain('No adapter knows when a session of "codex" waits for a person');
  });
});

describe('bridge caller', () => {
  const hookInput = JSON.stringify({
    session_id: 'session-now',
    cwd: '/work/demo',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__bridge__report',
    tool_input: { job: 3, result: 'Done' },
  });

  function caller(input: string | undefined, extra: Partial<BridgeCallerContext> = {}) {
    const written: string[] = [];
    const context: BridgeCallerContext = {
      write: (text) => written.push(text),
      env: { CLAUDE_CODE_SESSION_ID: 'session-then' },
      cwd: project,
      stdin: async () => input,
      adapters: [claudeCodeAdapter(), codexAdapter()],
      ...extra,
    };
    return { context, written };
  }

  it('answers a hook of Claude Code with the arguments and the session of the call', async () => {
    const { context, written } = caller(hookInput);

    expect(await runBridgeCaller({ hook: 'claude-code' }, context)).toBe(0);

    expect(JSON.parse(written.join(''))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          job: 3,
          result: 'Done',
          _bridge: { harness: 'claude-code', session: 'session-now', cwd: '/work/demo' },
        },
      },
    });
  });

  it('answers nothing, and lets the call go on, when the input names no session', async () => {
    for (const input of [undefined, '', 'not json', JSON.stringify({ tool_input: {} })]) {
      const { context, written } = caller(input);

      expect(await runBridgeCaller({ hook: 'claude-code' }, context)).toBe(0);
      expect(written).toEqual([]);
    }
  });

  it('never exits with the code a harness reads as a refusal of the tool call', async () => {
    const codexHook = caller(hookInput);
    expect(await runBridgeCaller({ hook: 'codex' }, codexHook.context)).toBe(1);
    expect(codexHook.written).toEqual([]);
    expect(failed()).toContain('No adapter names the sessions of "codex" to the tools');

    const broken = caller(hookInput, {
      stdin: async () => {
        throw new Error('stdin is gone');
      },
    });
    expect(await runBridgeCaller({ hook: 'claude-code' }, broken.context)).toBe(1);

    const usage = new CommanderError(
      1,
      'commander.missingMandatoryOptionValue',
      "error: required option '--hook <harness>' not specified"
    );
    expect(exitCodeFor(usage, ['bridge', 'caller'])).toBe(1);
    expect(exitCodeFor(usage, ['bridge', 'install', '--bogus'])).toBe(2);
  });
});

describe('bridge wait --tools', () => {
  it('tells a woken session to reply with the tools, not with the command line', async () => {
    const host = await hostBridge({ home: bridgeDir, tickMs: 25 });
    hosts.push(host);
    const env = { COGITATOR_BRIDGE_HOME: bridgeDir, CLAUDE_CODE_SESSION_ID: 'claude-1' };
    const woken: string[] = [];
    const waiting = runBridgeWait(
      { timeout: 30, tools: true },
      {
        print: (line) => lines.push(line),
        wake: (text) => woken.push(text),
        env,
        cwd: project,
        stdin: async () => undefined,
        adapters: [],
      }
    );
    const sender = await BridgeClient.connect({
      socketPath: bridgePaths({ home: bridgeDir }).socket,
      caller: { harness: 'codex', sessionId: 'thread-1', cwd: project, project },
    });
    try {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [claude] = await sender.agents({ harness: 'claude-code' });
        if (claude) {
          await sender.createJob({ to: claude.name, body: 'Review the diff' });
          break;
        }
        if (Date.now() > deadline) throw new Error('the waiter never registered');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await waiting).toBe(2);
    } finally {
      await sender.close();
    }

    expect(woken[0]).toContain('Review the diff');
    expect(woken[0].endsWith(TOOLS_REPLY_HINT)).toBe(true);
    expect(woken[0]).not.toContain('send --job');
  });
});

describe('bridge install and uninstall', () => {
  const calls: string[] = [];

  function step(title: string, fail?: string): SetupStep {
    return {
      title,
      lines: [`+ ${title.toLowerCase()}`],
      apply: async () => {
        if (fail) throw new Error(fail);
        calls.push(title);
      },
    };
  }

  function setup(install: SetupStep[], uninstall: SetupStep[] = []): AdapterSetup {
    return {
      install: vi.fn(async () => install),
      uninstall: vi.fn(async () => uninstall),
    };
  }

  function context(
    setups: BridgeInstallContext['setups'],
    answer?: boolean
  ): BridgeInstallContext & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      io: {
        print: (line) => lines.push(line),
        confirm: async (question) => {
          asked.push(question);
          return answer;
        },
      },
      env: { COGITATOR_BRIDGE_HOME: bridgeDir },
      cwd: project,
      setups,
    };
  }

  beforeEach(() => {
    calls.length = 0;
  });

  it('lists every change, asks once, and makes them in order after a yes', async () => {
    const claude = setup([step('Register the server'), step('Edit the settings')]);
    const codex = setup([step('Register with Codex')]);
    const ctx = context({ claude, codex }, true);

    expect(await runBridgeInstall(undefined, { takeJobs: true }, ctx)).toBe(0);

    expect(output()).toContain(`Setting up the agent bridge for the project ${project}`);
    expect(output()).toMatch(
      /Claude Code\n {2}1\. Register the server\n {7}\+ register the server\n {2}2\. Edit the settings\n {7}\+ edit the settings\nCodex\n {2}3\. Register with Codex/
    );
    expect(ctx.asked).toEqual(['Make these 3 changes?']);
    expect(calls).toEqual(['Register the server', 'Edit the settings', 'Register with Codex']);
    expect(claude.install).toHaveBeenCalledWith({
      project,
      scope: 'project',
      notes: true,
      takeJobs: true,
      allowTools: true,
    });
    expect(output()).toContain('Done: 3 changes');
    expect(output()).toContain('No dispatcher runs yet');
    expect(output()).toContain('cogitator bridge doctor');
  });

  it('sets up the checkout it runs in: a linked worktree, not the main checkout it belongs to', async () => {
    const gitDir = join(project, '.git', 'worktrees', 'feature');
    const worktree = join(project, 'trees', 'feature');
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`);
    const claude = setup([step('Register the server')], [step('Remove the server')]);
    const inWorktree = { ...context({ claude }, true), cwd: join(worktree, 'src') };

    expect(await runBridgeInstall(undefined, {}, inWorktree)).toBe(0);
    expect(await runBridgeUninstall(undefined, {}, inWorktree)).toBe(0);
    expect(await runBridgeInstall(undefined, { cwd: worktree }, context({ claude }, true))).toBe(0);

    expect(output()).toContain(`Setting up the agent bridge for the project ${worktree}`);
    expect(vi.mocked(claude.install).mock.calls.map(([asked]) => asked.project)).toEqual([
      worktree,
      worktree,
    ]);
    expect(vi.mocked(claude.uninstall).mock.calls.map(([asked]) => asked.project)).toEqual([
      worktree,
    ]);
  });

  it('changes nothing after a no, with --dry-run, or when nobody can answer', async () => {
    const setups = { claude: setup([step('Register the server')]) };

    expect(await runBridgeInstall('claude', {}, context(setups, false))).toBe(0);
    expect(output()).toContain('Nothing was changed');

    const dry = context(setups, true);
    expect(await runBridgeInstall('claude', { dryRun: true }, dry)).toBe(0);
    expect(dry.asked).toEqual([]);

    expect(await runBridgeInstall('claude', {}, context(setups))).toBe(1);
    expect(failed()).toContain('Nothing was changed: nobody is here to confirm');
    expect(failed()).toContain('--yes');
    expect(calls).toEqual([]);
  });

  it('makes the changes without asking with --yes, and passes the choices on', async () => {
    const claude = setup([step('Register the server')]);
    const ctx = context({ claude });

    expect(
      await runBridgeInstall(
        'claude',
        { yes: true, user: true, notes: false, allow: false, cwd: 'packages/api' },
        ctx
      )
    ).toBe(0);

    expect(ctx.asked).toEqual([]);
    expect(calls).toEqual(['Register the server']);
    expect(claude.install).toHaveBeenCalledWith({
      project: join(project, 'packages', 'api'),
      scope: 'user',
      notes: false,
      takeJobs: false,
      allowTools: false,
    });
    expect(output()).toContain('Setting up the agent bridge for every project of yours');
  });

  it('says so when everything is in place, and asks nothing', async () => {
    const ctx = context({ claude: setup([]), codex: setup([]) }, true);

    expect(await runBridgeInstall('all', {}, ctx)).toBe(0);

    expect(ctx.asked).toEqual([]);
    expect(output()).toContain('nothing to change');
    expect(output()).toContain('Everything is in place already');
  });

  it('leaves out a harness that is not installed, and fails when it was the one asked for', async () => {
    const absent: AdapterSetup = {
      install: async () => {
        throw new CommandMissingError('codex');
      },
      uninstall: async () => [],
    };
    const setups = { claude: setup([step('Register the server')]), codex: absent };

    expect(await runBridgeInstall(undefined, { yes: true }, context(setups))).toBe(0);
    expect(output()).toContain('Codex\n  not installed on this machine, left out');
    expect(calls).toEqual(['Register the server']);

    expect(await runBridgeInstall('codex', { yes: true }, context(setups))).toBe(1);
    expect(failed()).toContain('Codex is not installed: codex is not installed, or not on PATH');

    expect(await runBridgeInstall(undefined, { yes: true }, context({ codex: absent }))).toBe(1);
    expect(failed()).toContain('Neither Claude Code nor Codex is installed');
  });

  it('names the change that failed and how far it got', async () => {
    const setups = {
      claude: setup([
        step('Register the server'),
        step('Edit the settings', 'the file is read-only'),
        step('Add the notes'),
      ]),
    };

    expect(await runBridgeInstall('claude', { yes: true }, context(setups))).toBe(1);

    expect(calls).toEqual(['Register the server']);
    expect(failed()).toContain('"Edit the settings" failed: the file is read-only');
    expect(failed()).toContain('The 1 change before it was made');
  });

  it('prints the changes as JSON, and asks nothing then', async () => {
    const setups = { claude: setup([step('Register the server')]) };

    expect(await runBridgeInstall('claude', { json: true, dryRun: true }, context(setups))).toBe(0);
    expect(JSON.parse(lines.join(''))).toEqual({
      applied: false,
      changes: [
        { harness: 'claude', title: 'Register the server', lines: ['+ register the server'] },
      ],
      missing: [],
    });

    lines = [];
    expect(await runBridgeInstall('claude', { json: true, yes: true }, context(setups))).toBe(0);
    expect(JSON.parse(lines.join(''))).toMatchObject({ applied: true });

    lines = [];
    expect(await runBridgeInstall('claude', { json: true }, context(setups))).toBe(2);
    expect(JSON.parse(lines.join(''))).toMatchObject({ ok: false });
  });

  it('refuses a harness it does not know', async () => {
    expect(await runBridgeInstall('cursor', {}, context({}))).toBe(2);
    expect(failed()).toContain('"cursor" is not a harness the bridge sets up');
  });

  it('takes the bridge out again, and says what Codex keeps for other projects', async () => {
    const claude = setup([], [step('Remove the server')]);
    const codex = setup([], [step('Remove the notes')]);
    const ctx = context({ claude, codex }, true);

    expect(await runBridgeUninstall(undefined, {}, ctx)).toBe(0);

    expect(output()).toContain(`Taking the agent bridge out of the project ${project}`);
    expect(calls).toEqual(['Remove the server', 'Remove the notes']);
    expect(claude.uninstall).toHaveBeenCalledWith({ project, scope: 'project' });
    expect(output()).toContain('cogitator bridge uninstall codex --user');

    lines = [];
    expect(await runBridgeUninstall('claude', { user: true }, context({ claude: setup([]) }))).toBe(
      0
    );
    expect(output()).toContain('Nothing of the bridge is set up here');
    expect(output()).not.toContain('uninstall codex --user');
  });
});

describe.skipIf(process.platform === 'win32')('bridge install on the harnesses', () => {
  let fakes: FakeHarnesses;

  beforeEach(() => {
    fakes = installFakeHarnesses();
  });

  afterEach(async () => {
    await fakes.cleanup();
  });

  it('sets both harnesses up with the server and the hooks this command line would run', async () => {
    const env = fakes.env({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      COGITATOR_BRIDGE_HOME: bridgeDir,
      COGITATOR_BRIDGE_COMMAND: 'my-cogitator bridge',
    });
    const io = { print: (line: string) => lines.push(line), confirm: async () => true };

    expect(await runBridgeInstall(undefined, {}, { io, env, cwd: project })).toBe(0);

    expect(output()).toContain('exec my-cogitator bridge mcp --home');
    const local = JSON.parse(
      readFileSync(join(fakes.home, 'claude-config', '.claude.json'), 'utf8')
    ) as { projects: Record<string, { mcpServers: Record<string, { command: string }> }> };
    expect(Object.values(local.projects)[0].mcpServers.bridge.command).toBe('sh');
    const settings = readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8');
    expect(settings).toContain('my-cogitator bridge wait --hook claude-code');
    expect(settings).toContain(`--home ${bridgeDir} --tools`);
    expect(settings).toContain('my-cogitator bridge caller --hook claude-code');
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toContain(BRIDGE_NOTES_START);
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain(BRIDGE_NOTES_START);
    expect((await fakes.run('codex', ['mcp', 'get', 'bridge'])).code).toBe(0);

    lines = [];
    expect(await runBridgeInstall(undefined, {}, { io, env, cwd: project })).toBe(0);
    expect(output()).toContain('Everything is in place already');

    expect(await runBridgeUninstall(undefined, { yes: true }, { io, env, cwd: project })).toBe(0);
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    expect((await fakes.run('codex', ['mcp', 'get', 'bridge'])).code).toBe(0);
  });

  it('builds the setups and the adapters from the same command line', () => {
    const env = {
      COGITATOR_BRIDGE_COMMAND: 'my-cogitator bridge',
      COGITATOR_BRIDGE_HOME: bridgeDir,
    };

    expect(Object.keys(bridgeSetups(env))).toEqual(['claude', 'codex']);
    expect(bridgeAdapters(env).map((adapter) => adapter.harness)).toEqual(['claude-code', 'codex']);
  });
});
