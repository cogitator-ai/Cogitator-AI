import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { BridgeClient, bridgePaths } from '@cogitator-ai/bridge';
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let bridgeDir: string;
let project: string;
let personHome: string;
const children: ChildProcess[] = [];
const clients: BridgeClient[] = [];

function scratch(prefix: string): string {
  const base = posix && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

/**
 * The environment of the command line: the stand-ins of the harnesses, the bridge of this test,
 * and a home of its own, so the settings of whoever runs the tests decide nothing here. It
 * names no session: the commands of the person are refused inside one.
 */
function env(): NodeJS.ProcessEnv {
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _codex,
    COGITATOR_BRIDGE_AGENT: _agent,
    ...rest
  } = fakes.env({
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    COGITATOR_BRIDGE_HOME: bridgeDir,
    HOME: personHome,
  });
  return rest;
}

async function until<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  detail: () => string = () => ''
): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function serve(): Promise<() => string> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve'], { env: env() });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await until(
    () => output.includes('Bridge dispatcher running'),
    'the dispatcher to start',
    () => output
  );
  return () => output;
}

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: env(),
    cwd: project,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function conductor(): Promise<BridgeClient> {
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home: bridgeDir }).socket,
    caller: { harness: 'conductor', sessionId: 'conductor-1', cwd: project, project },
  });
  clients.push(client);
  return client;
}

/** The rules of the project that only the bridge reads: the stand-in of claude goes by `.claude`. */
function bridgeRules(permissions: { allow?: string[]; deny?: string[] }): void {
  mkdirSync(join(project, '.cogitator'), { recursive: true });
  writeFileSync(join(project, '.cogitator', 'settings.json'), JSON.stringify({ permissions }));
}

beforeEach(() => {
  fakes = installFakeHarnesses();
  bridgeDir = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  personHome = scratch('cb-home-');
  mkdirSync(join(project, '.git'));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await fakes.cleanup();
  for (const dir of [bridgeDir, project, personHome]) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)('a Claude Code session the bridge starts', () => {
  it('asks leave through the bridge, and goes on once the person allows the call', async () => {
    fakes.trustFolder(project);
    const served = await serve();
    const client = await conductor();

    await client.createJob({
      to: 'claude',
      body: 'Ship the fix\nedit: notes.txt\nbash: echo pushed\nsay: Shipped',
    });
    const asks = await until(
      () => {
        const listed = cli(['asks']);
        return listed.stdout.includes('asks leave') ? listed.stdout : undefined;
      },
      'the request to reach the person',
      served
    );

    expect(asks).toContain('Job #1 "Ship the fix"');
    expect(asks).toContain(`Run in ${project}:`);
    expect(asks).toContain('echo pushed');
    expect(asks).toContain('Allow: cogitator bridge allow 1');
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('edited\n');
    const [session] = await fakes.claudeSessions();
    expect(session).not.toHaveProperty('waitingFor');

    const allowed = cli(['allow', '1', 'The', 'branch', 'is', 'reviewed']);

    expect(allowed).toMatchObject({ status: 0 });
    expect(allowed.stdout).toMatch(/^Allowed: claude@\S+ is told\. Job #1 is working/);
    const turn = await fakes.waitForTurn('claude', session.sessionId, () => true);
    expect(turn.ran.map((run) => [run.command, run.code, run.stdout])).toEqual([
      ['edit notes.txt', 0, ''],
      ['echo pushed', 0, 'pushed\n'],
    ]);
    expect(cli(['asks']).stdout).toContain('Nothing waits for you');
    await until(
      () => readFileSync(join(bridgeDir, 'inbox.json'), 'utf8').includes('"archived"'),
      'the item of the request to be put away'
    );
  });

  it('is answered by the agent that handed the job over when the rules of the project allow the call, and refused when they forbid it', async () => {
    fakes.trustFolder(project);
    bridgeRules({ allow: ['Bash(echo *)'], deny: ['Bash(rm *)'] });
    await serve();
    const client = await conductor();

    await client.createJob({
      to: 'claude',
      body: 'Clean up\nbash: rm -rf build\nbash: echo done\nsay: Cleaned',
    });
    const request = await until(async () => {
      const mail = await client.inbox();
      return mail.find((letter) => letter.kind === 'permission');
    }, 'the request for the command the rules allow');

    expect(request.ask).toMatchObject({ tool: 'Bash', command: 'echo done' });
    expect(request.needsPerson).toBeUndefined();
    await client.send({ job: 1, kind: 'answer', body: 'Go on', verdict: 'allow' });
    const [session] = await fakes.claudeSessions();
    const turn = await fakes.waitForTurn('claude', session.sessionId, () => true);

    expect(turn.ran[0]).toMatchObject({ command: 'rm -rf build', code: null, denied: true });
    expect(turn.ran[0].stderr).toMatch(
      /^Refused by bridge: The rules of conductor@\S+ forbid this/
    );
    expect(turn.ran[1]).toMatchObject({ command: 'echo done', code: 0, stdout: 'done\n' });
    expect(cli(['asks']).stdout).toContain('Nothing waits for you');
  });
});

describe.skipIf(!posix)('a Claude Code window a person opened', () => {
  it('says through the hook of bridge install that it waits for them at its dialog', async () => {
    fakes.trustFolder(project);
    const installed = cli(['install', 'claude', '--yes']);
    expect(installed.status, installed.stderr).toBe(0);
    await serve();
    const sessionId = await fakes.openClaudeWindow({ cwd: project, env: env() });
    await fakes.say(sessionId, 'say: here');
    await fakes.waitForTurn('claude', sessionId, () => true);
    const client = await conductor();
    const window = await until(
      async () => (await client.agents({ harness: 'claude-code', statuses: ['active'] }))[0],
      'the window to be known'
    );

    await client.createJob({
      to: window.name,
      body: 'Ship the fix\nbash: echo pushed\nsay: Shipped',
    });
    const note = await until(async () => {
      const mail = await client.inbox();
      return mail.find((letter) => letter.kind === 'note');
    }, 'the note that the window waits');

    expect(note.body).toContain(`${window.name} waits for a person at its own window`);
    expect(note.body).toContain('> Claude needs your permission to use Bash');
    await until(() => {
      const inbox = join(bridgeDir, 'inbox.json');
      return (
        existsSync(inbox) &&
        readFileSync(inbox, 'utf8').includes(`${window.name} waits for you at its own window`)
      );
    }, 'the notice in the inbox of the bridge');
    await fakes.answerPermission(sessionId, 'allow');
    const turn = await fakes.waitForTurn('claude', sessionId, (done) => done.answer === 'Shipped');
    expect(turn.ran[0]).toMatchObject({ code: 0, stdout: 'pushed\n' });
  });
});
