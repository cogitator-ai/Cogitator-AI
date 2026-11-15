import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  bridgePaths,
  claudeCodeAdapter,
  hostBridge,
  type BridgeAdapter,
  type BridgeHost,
  type HealthCheck,
} from '@cogitator-ai/bridge';
import {
  REPLY_HINT,
  runBridgeDelegate,
  runBridgeDoctor,
  runBridgeInbox,
  runBridgeSend,
  runBridgeWait,
  type BridgeSessionContext,
} from '../commands/bridge-session.js';
import { bridgeCommandOf } from '../utils/bridge-adapters.js';
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
    const job = await (await watcher()).job(1);
    expect(job).toMatchObject({ state: 'completed', checks: [{ command: 'pnpm test' }] });

    lines = [];
    await runBridgeInbox({ job: 1 }, claude());
    expect(output()).toContain('Done:\n14 pass');
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
      REPLY_HINT,
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

  it('takes the name the bridge gave a session it started', async () => {
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

    expect(await waiting).toBe(2);
    const agents = await host.dispatcher.agents({ harness: 'claude-code' });
    expect(agents).toMatchObject([
      { name: started[0], sessionId: 'claude-started', status: 'active' },
    ]);
    finishStart();
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

describe('how a hook reaches the command line', () => {
  it('runs the way this process was run, unless told otherwise', () => {
    expect(bridgeCommandOf({})).toBe(`${process.execPath} ${process.argv[1]} bridge`);
    expect(bridgeCommandOf({ COGITATOR_BRIDGE_COMMAND: ' my-cogitator bridge ' })).toBe(
      'my-cogitator bridge'
    );
  });
});

describe('the bridge commands of the program', () => {
  it('parses what a session types', () => {
    const bridge = createProgram().commands.find((command) => command.name() === 'bridge');
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
