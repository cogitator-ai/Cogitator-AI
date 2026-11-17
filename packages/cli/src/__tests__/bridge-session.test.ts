import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  bridgePaths,
  claudeCodeAdapter,
  hostBridge,
  shellQuote,
  type BridgeAdapter,
  type BridgeHost,
  type HealthCheck,
} from '@cogitator-ai/bridge';
import { memoryBoard } from '@cogitator-ai/bridge/memory';
import {
  contextFile,
  replyHint,
  runBridgeAccept,
  runBridgeDelegate,
  runBridgeDiff,
  runBridgeForget,
  runBridgeRecall,
  runBridgeReject,
  runBridgeRemember,
  runBridgeDoctor,
  runBridgeInbox,
  runBridgeSend,
  runBridgeCancel,
  runBridgeWait,
  type BridgeSessionContext,
} from '../commands/bridge-session.js';
import {
  bridgeAdapters,
  bridgeCommandOf,
  claudeModeOf,
  codexSandboxOf,
} from '../utils/bridge-adapters.js';
import { UsageError, exitCodeFor } from '../utils/cli.js';
import { createProgram } from '../program.js';

let home: string;
let project: string;
let lines: string[];
let woken: string[];
let failures: string[];
const hosts: BridgeHost[] = [];
const clients: BridgeClient[] = [];

const CLAUDE_ENV = 'CLAUDE_CODE_SESSION_ID';
const CODEX_ENV = 'CODEX_THREAD_ID';

function session(variable: string, id: string, extra: Partial<BridgeSessionContext> = {}) {
  const context: BridgeSessionContext = {
    print: (line) => lines.push(line),
    wake: (text) => woken.push(text),
    env: { COGITATOR_BRIDGE_HOME: home, [variable]: id },
    cwd: project,
    stdin: async () => undefined,
    adapters: [],
    ...extra,
  };
  return context;
}

const claude = (extra?: Partial<BridgeSessionContext>) => session(CLAUDE_ENV, 'claude-1', extra);
const codex = (extra?: Partial<BridgeSessionContext>) => session(CODEX_ENV, 'thread-1', extra);

async function startHost(): Promise<BridgeHost> {
  const host = await hostBridge({ home, tickMs: 25 });
  hosts.push(host);
  return host;
}

async function watcher(): Promise<BridgeClient> {
  const client = await BridgeClient.connect({ socketPath: bridgePaths({ home }).socket });
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

const output = () => stripVTControlCharacters(lines.join('\n'));
const failed = () => stripVTControlCharacters(failures.join('\n'));

beforeEach(() => {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  home = mkdtempSync(join(base, 'cb-cli-'));
  project = mkdtempSync(join(base, 'cb-proj-'));
  lines = [];
  woken = [];
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
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('bridge remember, recall and forget', () => {
  it('keep the notes of a project, from its sessions and from the person', async () => {
    mkdirSync(join(project, '.git'));
    const board = await memoryBoard({ store: ':memory:' });
    hosts.push(await hostBridge({ home, tickMs: 25, board }));
    const person = (extra: Partial<BridgeSessionContext> = {}): BridgeSessionContext => ({
      print: (line) => lines.push(line),
      wake: (text) => woken.push(text),
      env: { COGITATOR_BRIDGE_HOME: home },
      cwd: project,
      stdin: async () => undefined,
      adapters: [],
      ...extra,
    });
    const checkout = realpathSync(project);

    expect(await runBridgeRecall([], {}, person())).toBe(0);
    expect(output()).toBe('The board of this project is empty');

    lines = [];
    expect(await runBridgeRemember(['Deploys', 'are', 'frozen'], {}, person())).toBe(0);
    expect(output()).toMatch(new RegExp(`^Kept as \\S+, for every agent of ${checkout}$`));
    await runBridgeRemember(
      [],
      { lesson: true },
      codex({ stdin: async () => 'Mocking Redis hid a race: run a real one\n' })
    );

    lines = [];
    expect(await runBridgeRecall([], {}, claude())).toBe(0);
    const listed = output().split('\n');
    expect(listed).toEqual([
      expect.stringMatching(
        /^\S+ {2}Mocking Redis hid a race: run a real one \(lesson from codex@\S+, \d{4}-\d{2}-\d{2}\)$/
      ),
      expect.stringMatching(
        /^\S+ {2}Deploys are frozen \(fact from the person, \d{4}-\d{2}-\d{2}\)$/
      ),
    ]);
    lines = [];
    await runBridgeRecall(['deploys'], { kind: 'fact' }, person());
    expect(output()).toContain('Deploys are frozen');
    expect(output()).not.toContain('Redis');
    lines = [];
    await runBridgeRecall(['kubernetes'], {}, person());
    expect(output()).toBe('Nothing on the board fits that');

    const lesson = listed[0].split(' ')[0];
    const fact = listed[1].split(' ')[0];
    expect(await runBridgeForget(fact, {}, claude())).toBe(1);
    expect(failed()).toContain('only they, or the person, let it go');
    lines = [];
    expect(await runBridgeForget(lesson.slice(0, 8), {}, person())).toBe(0);
    expect(output()).toBe(
      `The note ${lesson} is off the board: Mocking Redis hid a race: run a real one`
    );
    await board.close?.();
  });

  it('hand a job over with what the flags name, and report with lessons', async () => {
    mkdirSync(join(project, '.git'));
    writeFileSync(
      join(project, 'limiter.ts'),
      'export const limit = 1;\nexport const burst = 1;\n'
    );
    const board = await memoryBoard({ store: ':memory:' });
    hosts.push(await hostBridge({ home, tickMs: 25, board }));
    await runBridgeInbox({}, codex());

    expect(
      await runBridgeDelegate(
        'codex',
        ['Raise the burst limit'],
        {
          done: ['The burst test passes'],
          constraint: ['No new dependencies'],
          decision: ['The limit stays per user'],
          file: ['limiter.ts:2=the constant'],
          contextTokens: 2000,
        },
        claude()
      )
    ).toBe(0);
    lines = [];
    await runBridgeInbox({}, codex());
    expect(output()).toContain(
      [
        'Done when:',
        '- The burst test passes',
        'Constraints:',
        '- No new dependencies',
        'Decided already:',
        '- The limit stays per user',
        'Files to start from:',
        '- limiter.ts lines 2-2 of 2: the constant',
        '  2| export const burst = 1;',
      ].join('\n')
    );

    await runBridgeSend(
      ['Raised it'],
      { job: 1, kind: 'report', lesson: ['The constant is read at start only'] },
      codex()
    );
    lines = [];
    await until(async () => {
      lines = [];
      await runBridgeRecall([], { kind: 'lesson' }, claude());
      return output().includes('The constant is read at start only');
    }, 'the lesson to reach the board');
    expect(output()).toMatch(/\(lesson from codex@\S+, job #1, /);
    await board.close?.();
  });

  it('reads a file of the context with its lines and what is there', () => {
    expect(contextFile('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(contextFile('src/a.ts:120-180')).toEqual({ path: 'src/a.ts', lines: '120-180' });
    expect(contextFile('src/a.ts:42=the retry loop')).toEqual({
      path: 'src/a.ts',
      lines: '42',
      why: 'the retry loop',
    });
    expect(contextFile('C:/work/a.ts=why = this')).toEqual({
      path: 'C:/work/a.ts',
      why: 'why = this',
    });
  });

  it('say so when the dispatcher keeps no board', async () => {
    await startHost();
    expect(await runBridgeRemember(['Anything'], {}, claude())).toBe(1);
    expect(failed()).toContain('This bridge keeps no notes');
  });
});

describe('bridge diff, accept and reject', () => {
  it('show what a job changed in its worktree, and take or drop its work', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trimEnd();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(project, 'README.md'), 'demo\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const checkout = realpathSync(project);
    const started: string[] = [];
    const starts: BridgeAdapter = {
      harness: 'codex',
      delivery: 'test',
      capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
      createSession: async (request) => {
        started.push(request.cwd);
        return { sessionId: `thread-${started.length}` };
      },
      deliver: async () => undefined,
    };
    hosts.push(await hostBridge({ home, tickMs: 25, adapters: [starts], rights: () => 'allow' }));
    const worker = (thread: number) => session(CODEX_ENV, `thread-${thread}`);
    const reported = async (job: number) => {
      await runBridgeSend(['Done'], { job, kind: 'report' }, worker(job));
      const watch = await watcher();
      await until(async () => (await watch.job(job)).checking === undefined, 'the checks');
    };

    expect(
      await runBridgeDelegate(
        'codex',
        ['Fix the limiter'],
        { worktree: true, check: ['test -f fixed.txt'] },
        claude()
      )
    ).toBe(0);
    expect(output().split('\n')[1]).toBe(
      '  It is done in a git worktree of its own. Its work comes back with: cogitator bridge accept 1'
    );
    await until(() => started.length === 1, 'the session of the job');
    writeFileSync(join(started[0], 'fixed.txt'), 'fixed\n');

    lines = [];
    expect(await runBridgeDiff(1, [], { stat: true }, claude())).toBe(0);
    expect(output().split('\n')).toEqual([
      `Job #1: 1 file, +1 -0, in ${started[0]} (branch cogitator/job-1-fix-the-limiter)`,
      '  A fixed.txt  +1 -0',
    ]);
    lines = [];
    expect(await runBridgeDiff(1, ['fixed.txt'], {}, claude())).toBe(0);
    expect(output()).toContain('+fixed');
    expect(await runBridgeAccept(1, {}, claude())).toBe(1);
    expect(failed()).toContain('Job 1 is still working');

    await reported(1);
    lines = [];
    expect(await runBridgeAccept(1, {}, claude())).toBe(0);
    expect(output().split('\n')).toEqual([
      `The work of job #1 is in ${checkout}: 1 file, +1 -0, staged and not committed`,
      '  Look at it: git diff --cached   Then commit it yourself',
    ]);
    expect(git('status', '--porcelain')).toBe('A  fixed.txt');
    git('commit', '-q', '-m', 'fixed');

    await runBridgeDelegate('codex:new', ['Another way'], { worktree: true }, claude());
    await until(() => started.length === 2, 'the second session');
    writeFileSync(join(started[1], 'fixed.txt'), 'theirs\n');
    writeFileSync(join(project, 'fixed.txt'), 'mine\n');
    git('commit', '-q', '-am', 'mine');
    await reported(2);
    lines = [];
    expect(await runBridgeAccept(2, {}, claude())).toBe(1);
    expect(output().split('\n')).toEqual([
      `Nothing was taken: the work of job #2 would leave these files of ${checkout} in conflict`,
      '  fixed.txt',
      '  Its worktree is still there. Take it as a branch: cogitator bridge accept 2 --as-branch   Or drop it: cogitator bridge reject 2',
    ]);
    expect(readFileSync(join(project, 'fixed.txt'), 'utf8')).toBe('mine\n');
    lines = [];
    expect(await runBridgeAccept(2, { asBranch: true }, claude())).toBe(0);
    expect(output()).toMatch(
      /^The work of job #2 is the branch cogitator\/job-2-another-way, at commit [0-9a-f]{10}$/
    );
    expect(git('show', 'cogitator/job-2-another-way:fixed.txt')).toBe('theirs');

    await runBridgeDelegate('codex:new', ['A third way'], { worktree: true }, claude());
    await until(() => started.length === 3, 'the third session');
    await reported(3);
    lines = [];
    expect(await runBridgeReject(3, ['Not', 'needed'], {}, claude())).toBe(0);
    expect(output()).toBe('The work of job #3 is dropped, and its worktree is gone');
    expect(existsSync(started[2])).toBe(false);
    lines = [];
    expect(await runBridgeDiff(3, [], {}, claude())).toBe(1);
    expect(failed()).toContain('The work of job 3 was dropped, and its worktree is gone');
  });
});

describe('bridge delegate, send and inbox', () => {
  it('carries a job from hand-over to report between two sessions', async () => {
    await startHost();
    await runBridgeInbox({}, codex());
    lines = [];

    expect(
      await runBridgeDelegate(
        'codex',
        ['Write', 'the tests'],
        { check: ['pnpm test'], title: 'Tests' },
        claude()
      )
    ).toBe(0);
    expect(output()).toMatch(
      /^Job #1 is with codex@cb-proj-\w+ \(submitted\)\. Its answer arrives as a letter/
    );

    lines = [];
    expect(await runBridgeInbox({}, codex())).toBe(0);
    expect(output().split('\n')).toEqual([
      expect.stringMatching(/^\[agent bridge\] job #1 "Tests" \| task from claude@/),
      'Write the tests',
      '[agent bridge] When you report, the bridge runs the checks of the job where you worked: `pnpm test`.',
    ]);

    lines = [];
    expect(await runBridgeSend(['Mock Redis?'], { job: 1, kind: 'question' }, codex())).toBe(0);
    expect(output()).toMatch(/^Sent the question \S+ to claude@\S+\. Job #1 is input-required$/);

    await runBridgeSend(['Yes'], { job: 1, kind: 'answer' }, claude());
    lines = [];
    expect(
      await runBridgeSend(
        [],
        { job: 1, kind: 'report' },
        codex({ stdin: async () => 'Done:\n14 pass\n' })
      )
    ).toBe(0);
    const job = await vi.waitFor(async () => {
      const found = await (await watcher()).job(1);
      expect(found.checking).toBeUndefined();
      return found;
    });
    expect(job).toMatchObject({
      state: 'completed',
      checks: [{ command: 'pnpm test' }],
      verification: { verified: false },
    });

    lines = [];
    await runBridgeInbox({ job: 1 }, claude());
    expect(output()).toContain('Done:\n14 pass');
    expect(output()).toContain(
      '[agent bridge] Checks. Not verified: 0 of 1 check passed.\n- not run: pnpm test: this bridge has no rules to judge a command by, and runs none without them'
    );
  });

  it('takes a job back for the session that handed it over, and for no other', async () => {
    await startHost();
    await runBridgeInbox({}, codex());
    await runBridgeDelegate('codex', ['Write', 'the tests'], {}, claude());

    lines = [];
    expect(await runBridgeCancel(1, [], {}, codex())).toBe(1);
    expect(failed()).toMatch(/Only claude@\S+, who handed job 1 over, can cancel it/);
    expect((await (await watcher()).job(1)).state).not.toBe('canceled');

    expect(await runBridgeCancel(1, ['Not', 'needed'], {}, claude())).toBe(0);
    expect(output()).toMatch(/^Job #1 is canceled, codex@\S+ is told$/);
    lines = [];
    await runBridgeInbox({}, codex());
    expect(output()).toContain('Not needed');

    failures = [];
    expect(await runBridgeCancel(1, [], {}, claude())).toBe(1);
    expect(failed()).toContain('Job 1 is already canceled');
    lines = [];
    await runBridgeDelegate('codex', ['Write', 'the tests'], {}, claude());
    expect(output()).toMatch(/^Job #2 is with codex@/);
  });

  it('looks without taking, and says when nothing waits', async () => {
    await startHost();
    await runBridgeInbox({}, codex());
    expect(output()).toBe('No letters wait for this session');
    await runBridgeDelegate('codex', ['Write the tests'], {}, claude());

    lines = [];
    await runBridgeInbox({ peek: true }, codex());
    expect(output()).toContain('Write the tests');
    expect((await (await watcher()).letters({ job: 1 }))[0].state).toBe('queued');

    await runBridgeInbox({}, codex());
    lines = [];
    await runBridgeInbox({}, codex());
    expect(output()).toBe('No letters wait for this session');
    lines = [];
    await runBridgeInbox({ unhandled: true }, codex());
    expect(output()).toContain('Write the tests');
  });

  it('prints JSON when asked', async () => {
    await startHost();
    await runBridgeInbox({}, codex());
    lines = [];

    await runBridgeDelegate('codex', ['Write the tests'], { json: true }, claude());
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ number: 1, state: 'submitted' });

    lines = [];
    await runBridgeInbox({ json: true }, codex());
    expect(JSON.parse(lines.join('\n'))).toMatchObject([{ kind: 'task', body: 'Write the tests' }]);

    lines = [];
    await runBridgeSend(['Done'], { job: 1, kind: 'report', failed: true, json: true }, codex());
    expect(JSON.parse(lines.join('\n'))).toMatchObject({
      letter: { kind: 'report', outcome: 'failed' },
      job: { state: 'failed' },
    });
  });

  it('refuses outside a session, without a dispatcher, and without a text', async () => {
    const terminal = session('NOTHING', 'x');
    expect(await runBridgeDelegate('codex', ['Write the tests'], {}, terminal)).toBe(1);
    expect(failed()).toContain('This command runs inside a session of an agent');
    expect(failed()).toContain('cogitator bridge status');

    failures = [];
    expect(await runBridgeInbox({}, claude())).toBe(1);
    expect(failed()).toContain('No bridge dispatcher is running');
    expect(failed()).toContain('cogitator bridge serve');

    await startHost();
    failures = [];
    expect(await runBridgeDelegate('codex', [], {}, claude())).toBe(1);
    expect(failed()).toContain('Nothing to send');
    failures = [];
    expect(await runBridgeDelegate('codex', ['-'], {}, claude({ stdin: async () => '  \n' }))).toBe(
      1
    );
    expect(failed()).toContain('Nothing to send');
    failures = [];
    expect(await runBridgeSend(['x'], { job: 1, kind: 'note', failed: true }, claude())).toBe(1);
    expect(failed()).toContain('--failed goes with --kind report');
    failures = [];
    expect(await runBridgeSend(['x'], { job: 9, kind: 'note' }, claude())).toBe(1);
    expect(failed()).toContain('9');
  });
});

describe('bridge wait', () => {
  it('wakes the session with its mail: the letters on stderr and exit code 2', async () => {
    const host = await startHost();
    const waiting = runBridgeWait({ timeout: 10 }, codex());
    await until(
      async () => (await host.dispatcher.status()).waiting.length === 1,
      'the waiter to arm'
    );

    await runBridgeDelegate('codex', ['Write the tests'], {}, claude());

    expect(await waiting).toBe(2);
    expect(woken).toHaveLength(1);
    expect(woken[0].split('\n')).toEqual([
      expect.stringMatching(/^\[agent bridge\] job #1 .* \| not typed by the user$/),
      'Write the tests',
      '',
      replyHint(bridgeCommandOf({ COGITATOR_BRIDGE_HOME: home })),
    ]);
    const client = await watcher();
    await until(
      async () => (await client.letters({ job: 1 }))[0].state === 'delivered',
      'the letter to be confirmed'
    );
    expect((await client.job(1)).state).toBe('working');
  });

  it('exits quietly with 0 when no mail comes', async () => {
    await startHost();

    expect(await runBridgeWait({ timeout: 1 }, codex())).toBe(0);

    expect(woken).toEqual([]);
    expect(lines).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('as a hook of Claude Code takes the session from what the harness wrote to it', async () => {
    const host = await startHost();
    const hooked = session('NOTHING', 'x', {
      adapters: [claudeCodeAdapter()],
      stdin: async () =>
        JSON.stringify({ session_id: 'claude-from-hook', cwd: project, hook_event_name: 'Stop' }),
    });

    const waiting = runBridgeWait({ hook: 'claude-code', timeout: 10 }, hooked);
    await until(
      async () => (await host.dispatcher.status()).waiting.length === 1,
      'the hook to arm'
    );
    const [agent] = await host.dispatcher.agents();
    expect(agent).toMatchObject({ harness: 'claude-code', sessionId: 'claude-from-hook' });

    await runBridgeDelegate('claude', ['Review it'], {}, codex());
    expect(await waiting).toBe(2);
    expect(woken[0]).toContain('Review it');
  });

  it('takes the name the bridge gave a session it started, and its first letter once the start is over', async () => {
    const started: string[] = [];
    let finishStart = (): void => undefined;
    const adapter: BridgeAdapter = {
      harness: 'claude-code',
      delivery: 'hook',
      capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
      identify: claudeCodeAdapter().identify,
      createSession: (request) => {
        started.push(request.agentName);
        return new Promise((resolve) => {
          finishStart = () => resolve({ sessionId: 'claude-started' });
        });
      },
    };
    const host = await hostBridge({ home, tickMs: 25, adapters: [adapter] });
    hosts.push(host);
    await runBridgeDelegate('claude', ['Review it'], {}, codex());
    await until(() => started.length === 1, 'the session start');

    const hooked = session(CLAUDE_ENV, 'claude-started', { adapters: [adapter] });
    const waiting = runBridgeWait({ hook: 'claude-code', timeout: 10, agent: started[0] }, hooked);

    await until(
      async () => (await host.dispatcher.status()).waiting.includes(started[0]),
      'the hook of the session being started to wait under its name'
    );
    expect(await host.dispatcher.agents({ harness: 'claude-code' })).toMatchObject([
      { name: started[0], sessionId: 'claude-started', status: 'active' },
    ]);
    expect(woken).toEqual([]);

    finishStart();

    expect(await waiting).toBe(2);
    expect(woken[0]).toContain('Review it');
    await host.dispatcher.idle();
    expect(await host.dispatcher.agents({ harness: 'claude-code' })).toHaveLength(1);
  });

  it('refuses a hook of a harness nothing tells apart, and a process of no session', async () => {
    expect(await runBridgeWait({ hook: 'gemini' }, claude())).toBe(1);
    expect(failed()).toContain('No adapter tells the sessions of "gemini" apart');

    failures = [];
    const nobody = session('NOTHING', 'x', { adapters: [claudeCodeAdapter()] });
    expect(await runBridgeWait({ hook: 'claude-code' }, nobody)).toBe(1);
    expect(failed()).toContain('This command runs inside a session of an agent');
  });
});

describe('a bridge in a folder named by --home', () => {
  it('is the one every session command calls, whatever the environment says', async () => {
    await startHost();
    const elsewhere = { COGITATOR_BRIDGE_HOME: join(home, 'not-this-one') };
    const asClaude = claude({ env: { ...elsewhere, [CLAUDE_ENV]: 'claude-1' } });
    const asCodex = codex({ env: { ...elsewhere, [CODEX_ENV]: 'thread-1' } });

    expect(await runBridgeInbox({ home }, asCodex)).toBe(0);
    expect(await runBridgeDelegate('codex', ['Write the tests'], { home }, asClaude)).toBe(0);
    const waited = await runBridgeWait({ home, timeout: 5 }, asCodex);
    expect(waited).toBe(2);
    expect(woken[0]).toContain(`--home ${home})`);
    expect(await runBridgeSend(['Done'], { home, job: 1, kind: 'report' }, asCodex)).toBe(0);
    expect(await runBridgeDoctor({ home }, asClaude)).toBe(0);
    expect(output()).toContain('Dispatcher: runs');

    failures = [];
    expect(await runBridgeInbox({}, asCodex)).toBe(1);
    expect(failed()).toContain('No bridge dispatcher is running');
  });
});

describe('bridge doctor', () => {
  function checked(harness: string, checks: HealthCheck[]): BridgeAdapter & { asked: string[] } {
    const asked: string[] = [];
    return {
      harness,
      delivery: 'test',
      capabilities: { createSession: false, push: false, steer: false, nativeWindow: false },
      health: async ({ cwd }) => {
        asked.push(cwd);
        return checks;
      },
      asked,
    };
  }

  it('shows the dispatcher and every harness, and passes when only warnings are left', async () => {
    await startHost();
    const claudeChecks = checked('claude-code', [
      { id: 'version', title: 'Claude Code', status: 'ok', detail: '2.1.292 (Claude Code)' },
      {
        id: 'hook',
        title: 'Wake hook',
        status: 'warn',
        detail: 'sessions do not wake for mail',
        fix: 'Merge the hook into .claude/settings.local.json',
      },
    ]);
    const context = claude({
      adapters: [claudeChecks, { ...checked('plain', []), health: undefined }],
    });

    expect(await runBridgeDoctor({}, context)).toBe(0);

    expect(output().split('\n')).toEqual([
      'bridge',
      expect.stringMatching(
        /^ {2}✓ Dispatcher: runs \(pid \d+, v[\d.]+\), adapters: none, no session waits for mail right now$/
      ),
      'claude-code',
      '  ✓ Claude Code: 2.1.292 (Claude Code)',
      '  ! Wake hook: sessions do not wake for mail',
      '    Merge the hook into .claude/settings.local.json',
    ]);
    expect(claudeChecks.asked).toEqual([project]);
  });

  it('fails when the dispatcher does not run or a harness lacks what the bridge needs', async () => {
    const codexChecks = checked('codex', [
      {
        id: 'queue',
        title: 'Message queue',
        status: 'fail',
        detail: 'no codex queue',
        fix: 'codex update',
      },
    ]);

    expect(await runBridgeDoctor({ json: true }, claude({ adapters: [codexChecks] }))).toBe(1);

    expect(JSON.parse(lines.join('\n'))).toEqual({
      ok: false,
      cwd: project,
      sections: [
        {
          harness: 'bridge',
          checks: [
            {
              id: 'dispatcher',
              title: 'Dispatcher',
              status: 'fail',
              detail: 'no bridge dispatcher is running: letters go nowhere',
              fix: 'cogitator bridge serve',
            },
          ],
        },
        { harness: 'codex', checks: [expect.objectContaining({ id: 'queue', status: 'fail' })] },
      ],
    });
  });

  it('checks the folder it is pointed at, and names the sessions that wait', async () => {
    const host = await startHost();
    const stop = new AbortController();
    const waiting = runBridgeWait({ timeout: 10 }, codex({ signal: stop.signal }));
    await until(
      async () => (await host.dispatcher.status()).waiting.length === 1,
      'the waiter to arm'
    );
    const checks = checked('codex', []);

    await runBridgeDoctor({ cwd: 'packages/core' }, claude({ adapters: [checks] }));

    expect(checks.asked).toEqual([join(project, 'packages/core')]);
    expect(output()).toMatch(/waiting for mail: codex@cb-proj-\w+/);
    stop.abort();
    expect(await waiting).toBe(0);
  });
});

describe('how a woken session is told to answer', () => {
  it('names the command line the way the session can run it', () => {
    expect(replyHint('/usr/bin/node /opt/cli.js bridge')).toBe(
      '(The agent bridge woke this session with the mail above. Answer through it, not in this chat: ' +
        '/usr/bin/node /opt/cli.js bridge send --job <number> --kind <answer|question|report|note> "<text>")'
    );
  });
});

describe('what bridge wait exits with', () => {
  it('never exits with the code that wakes a session unless it has mail', async () => {
    const usage = new CommanderError(
      1,
      'commander.unknownOption',
      "error: unknown option '--bogus'"
    );
    const badValue = new CommanderError(1, 'commander.invalidArgument', 'error: not a number');

    expect(exitCodeFor(usage, ['bridge', 'wait', '--bogus'])).toBe(1);
    expect(exitCodeFor(badValue, ['bridge', 'wait', '--timeout', '30.5'])).toBe(1);
    expect(exitCodeFor(usage, ['bridge', 'send', '--bogus'])).toBe(2);
    expect(
      exitCodeFor(new CommanderError(0, 'commander.helpDisplayed', ''), ['bridge', 'wait'])
    ).toBe(0);

    await startHost();
    const broken = codex({
      stdin: async () => {
        throw new UsageError('stdin is gone');
      },
      adapters: [claudeCodeAdapter()],
    });
    expect(await runBridgeWait({ hook: 'claude-code' }, broken)).toBe(1);
    expect(woken).toEqual([]);
  });

  it('names the bridge it works for when that is not the default one', () => {
    expect(replyHint('cogitator bridge', '/srv/my bridge')).toContain(
      `send --job <number> --kind <answer|question|report|note> "<text>" --home '/srv/my bridge')`
    );
  });
});

describe('text that starts with a dash', () => {
  it('goes after --, and the refusal says so', async () => {
    const program = await createProgram();
    const said: string[] = [];
    const quiet = (command: Awaited<ReturnType<typeof createProgram>>): void => {
      command.configureOutput({ writeErr: (text) => said.push(text), writeOut: () => undefined });
      for (const sub of command.commands) quiet(sub);
    };
    quiet(program);

    await expect(
      program.parseAsync(['bridge', 'send', '--job', '3', '--kind', 'answer', '- use the second'], {
        from: 'user',
      })
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(said.join('')).toContain('A text that starts with a dash goes after "--"');
  });
});

describe('how a hook reaches the command line', () => {
  it('runs the way this process was run, unless told otherwise', () => {
    expect(bridgeCommandOf({})).toBe(
      `${shellQuote(process.execPath)} ${shellQuote(process.argv[1] ?? '')} bridge`
    );
    expect(bridgeCommandOf({ COGITATOR_BRIDGE_COMMAND: ' my-cogitator bridge ' })).toBe(
      'my-cogitator bridge'
    );
  });

  it('tells the sessions of a dispatcher in a folder of its own where that folder is', async () => {
    const [claudeCode, codexThreads] = bridgeAdapters({ PATH: '/nowhere' }, { home });
    const hook = (await claudeCode.health?.({ cwd: project }))?.[0];
    expect(hook?.status).toBe('fail');

    const request = {
      agentName: 'codex@demo',
      harness: 'codex',
      project,
      cwd: project,
      job: { number: 1 } as never,
      firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
    };
    await expect(codexThreads.createSession?.(request)).rejects.toThrow('not installed');
    expect(existsSync(join(home, 'sessions'))).toBe(true);
    expect(bridgeAdapters({}).map((adapter) => adapter.harness)).toEqual(['claude-code', 'codex']);
  });

  it('starts Codex threads in the sandbox the flag or the environment names', async () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const seen = join(home, 'codex-args');
    writeFileSync(
      join(bin, 'codex'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\ncat > /dev/null\necho '{"type":"thread.started","thread_id":"t-1"}'\n`,
      { mode: 0o755 }
    );
    const env = { PATH: `${bin}:/usr/bin:/bin`, COGITATOR_BRIDGE_HOME: home };
    const request = {
      agentName: 'codex@demo',
      harness: 'codex',
      project,
      cwd: project,
      job: { number: 1 } as never,
      firstLetter: { text: '[agent bridge] job #1', body: 'x', job: 1 } as never,
    };
    const sandboxOf = async (adapters: ReturnType<typeof bridgeAdapters>): Promise<string> => {
      await adapters[1].createSession?.(request);
      const args = readFileSync(seen, 'utf8').split('\n');
      return args[args.indexOf('--sandbox') + 1];
    };

    expect(await sandboxOf(bridgeAdapters(env))).toBe('workspace-write');
    expect(
      await sandboxOf(bridgeAdapters({ ...env, COGITATOR_BRIDGE_CODEX_SANDBOX: 'read-only' }))
    ).toBe('read-only');
    expect(
      await sandboxOf(
        bridgeAdapters(
          { ...env, COGITATOR_BRIDGE_CODEX_SANDBOX: 'read-only' },
          { codexSandbox: 'danger-full-access' }
        )
      )
    ).toBe('danger-full-access');

    expect(codexSandboxOf({})).toBeUndefined();
    expect(() => bridgeAdapters({ COGITATOR_BRIDGE_CODEX_SANDBOX: 'wide-open' })).toThrow(
      UsageError
    );
    expect(() => codexSandboxOf({}, 'wide-open')).toThrow('"wide-open" is not a sandbox of Codex');
    const serve = (await createProgram()).commands
      .find((command) => command.name() === 'bridge')
      ?.commands.find((command) => command.name() === 'serve');
    expect(serve?.options.find((option) => option.long === '--codex-sandbox')?.argChoices).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]);
  });

  it('take the permission mode of the Claude Code sessions they start from the flag, then the environment', async () => {
    expect(claudeModeOf({})).toBeUndefined();
    expect(claudeModeOf({ COGITATOR_BRIDGE_CLAUDE_MODE: ' plan ' })).toBe('plan');
    expect(claudeModeOf({ COGITATOR_BRIDGE_CLAUDE_MODE: 'plan' }, 'default')).toBe('default');
    expect(() => claudeModeOf({}, 'yolo')).toThrow(
      '"yolo" is not a permission mode of Claude Code'
    );
    expect(() => bridgeAdapters({ COGITATOR_BRIDGE_CLAUDE_MODE: 'yolo' })).toThrow(UsageError);
    const serve = (await createProgram()).commands
      .find((command) => command.name() === 'bridge')
      ?.commands.find((command) => command.name() === 'serve');
    expect(serve?.options.find((option) => option.long === '--claude-mode')?.argChoices).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ]);
  });
});

describe('the bridge commands of the program', () => {
  it('parses what a session types', async () => {
    const bridge = (await createProgram()).commands.find((command) => command.name() === 'bridge');
    const send = bridge?.commands.find((command) => command.name() === 'send');
    expect(send?.options.find((option) => option.long === '--kind')?.argChoices).toEqual([
      'question',
      'answer',
      'report',
      'note',
      'permission',
    ]);
  });
});
