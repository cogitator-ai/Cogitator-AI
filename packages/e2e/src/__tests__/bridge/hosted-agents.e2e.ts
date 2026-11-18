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
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let bridgeDir: string;
let project: string;
let personHome: string;
const children: ChildProcess[] = [];

function scratch(prefix: string): string {
  const base = posix && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

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

interface Served {
  output: () => string;
  stop: () => Promise<void>;
}

async function serve(args: string[] = [], extra: NodeJS.ProcessEnv = {}): Promise<Served> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve', ...args], {
    env: { ...env(), ...extra },
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await until(
    () => output.includes('Bridge dispatcher running'),
    'the dispatcher to start',
    () => output
  );
  return {
    output: () => output,
    stop: async () => {
      children.splice(children.indexOf(child), 1);
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGINT');
      await gone;
    },
  };
}

function run(args: string[], session: NodeJS.ProcessEnv = {}, cwd: string = project) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: { ...env(), ...session },
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The command line as the session that hands the jobs over runs it: a Codex thread. */
const orchestrator = (args: string[]) => run(args, { CODEX_THREAD_ID: 'thread-orchestrator' });

const git = (...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
};

beforeEach(() => {
  fakes = installFakeHarnesses();
  bridgeDir = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  personHome = scratch('cb-home-');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'demo\n');
  writeFileSync(join(project, '.gitignore'), '.cogitator\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  mkdirSync(join(project, '.cogitator'), { recursive: true });
  writeFileSync(
    join(project, '.cogitator', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(test:*)'] } })
  );
  fakes.trustFolder(project);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await fakes.cleanup();
  for (const dir of [bridgeDir, project, personHome]) rmSync(dir, { recursive: true, force: true });
});

const MODEL = 'qwen2.5:0.5b';
let ollama: FakeOllama | undefined;

/** A model that writes the notes with its first answer and says so with its second. */
async function writingModel(): Promise<FakeOllama> {
  ollama = await startFakeOllama(
    (messages) =>
      messages.some((message) => message.role === 'tool')
        ? { content: 'Wrote notes.txt' }
        : {
            toolCalls: [
              { name: 'write_file', arguments: { path: 'notes.txt', content: 'drafted\n' } },
            ],
          },
    [MODEL]
  );
  return ollama;
}

afterEach(async () => {
  await ollama?.close();
  ollama = undefined;
});

describe.skipIf(!posix)(
  'agents of the runtime the dispatcher hosts, on the real command line',
  () => {
    it('does a job in its folder on the model named, and the answer of the model is the report', async () => {
      const fake = await writingModel();
      const served = await serve(['--agent', `qwen=ollama/${MODEL}`], {
        COGITATOR_OLLAMA_BASE_URL: fake.url,
      });
      expect(run(['status']).stdout).toContain('Adapters: claude-code, codex, qwen, recipe');

      const handed = orchestrator([
        'delegate',
        'qwen',
        '--type',
        'docs',
        '--check',
        'test -f notes.txt',
        'Write the notes of the project into notes.txt',
      ]);
      expect(handed.status, handed.stderr).toBe(0);
      expect(handed.stdout).toMatch(/Job #1 is with qwen@\S+ \(submitted\)/);

      const mail = await until(
        () => {
          const read = orchestrator(['inbox', '--peek']);
          return read.stdout.includes('Checks.') ? read.stdout : undefined;
        },
        'the report of the hosted agent',
        () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-15).join('\n')}`
      );
      expect(mail).toContain('report from qwen@');
      expect(mail).toContain('Wrote notes.txt');
      expect(mail).toContain('Checks. Verified: the check passed.');
      expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('drafted\n');
      expect(fake.requests[0].model).toBe(MODEL);
      expect(fake.requests[0].tools).toContain('write_file');
      expect(fake.requests[0].messages.at(-1)?.content).toContain('Write the notes of the project');
      expect(run(['results']).stdout).toMatch(
        /^#1 {2}qwen@\S+ {2}docs {2}good \(its checks passed\)/
      );
      const author = /Job #1 is with (qwen@\S+)/.exec(handed.stdout)?.[1] ?? '';
      const again = orchestrator(['delegate', author, 'Now say what you wrote']);
      expect(again.status, again.stderr).toBe(0);
      await until(
        () => orchestrator(['inbox', '--peek', '--job', '2']).stdout.includes('report from qwen@'),
        'the report of the second job'
      );
      const later = fake.requests.at(-1)?.messages ?? [];
      expect(later.at(-1)?.content).toContain('Now say what you wrote');
      expect(
        later.some((message) => message.content.includes('Write the notes of the project'))
      ).toBe(true);
      expect(later.some((message) => message.role === 'tool')).toBe(true);
      expect(served.output()).not.toContain('!');
    });

    it('takes a job as the agent of last resort when the others ran into their limits', async () => {
      const fake = await writingModel();
      const served = await serve(['--agent', `qwen=ollama/${MODEL}`, '--fallback', 'qwen'], {
        COGITATOR_OLLAMA_BASE_URL: fake.url,
        FAKE_CODEX_TURN_FAIL: 'You\u2019ve hit your usage limit. Try again later.',
        FAKE_CLAUDE_TURN_ERROR: 'rate_limit',
        FAKE_CLAUDE_TURN_ERROR_TEXT: "You've hit your session limit · resets 3:45pm",
      });
      const before = orchestrator(['suggest']).stdout;
      expect(before).toMatch(/claude .*<- auto takes this one/);
      expect(before).toMatch(/qwen .*takes a job only when no other agent can/);

      const handed = orchestrator(['delegate', 'codex:new', 'Write the notes into notes.txt']);
      expect(handed.status, handed.stderr).toBe(0);

      const mail = await until(
        () => {
          const read = orchestrator(['inbox', '--peek']);
          return read.stdout.includes('report from qwen@') ? read.stdout : undefined;
        },
        'the report of the agent of last resort',
        () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-20).join('\n')}`
      );
      expect(mail).toContain('Wrote notes.txt');
      expect(mail).toMatch(/ran into the limit of codex .*so the bridge handed the job to claude/);
      expect(mail).toMatch(/ran into the limit of claude .*so the bridge handed the job to qwen/);
      expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('drafted\n');
      const limits = run(['limits']).stdout;
      expect(limits).toMatch(/^claude {2}until (?:\w{3} \d{1,2} )?15:45/m);
      expect(limits).toMatch(
        /^codex {2}until (?:\w{3} \d{1,2} )?\d\d:\d\d, then the bridge tries it again/m
      );
      expect(orchestrator(['suggest']).stdout).toMatch(/qwen .*<- auto takes this one/);
      expect(served.output()).not.toContain('!');
    });

    it('refuses an agent whose name is taken or whose model names no provider', () => {
      const taken = run(['serve', '--agent', `codex=ollama/${MODEL}`]);
      expect(taken.status).not.toBe(0);
      expect(taken.stderr).toContain('An agent the bridge hosts cannot be called "codex"');
      const bare = run(['serve', '--agent', 'qwen=qwen3']);
      expect(bare.status).not.toBe(0);
      expect(bare.stderr).toContain('The model "qwen3" names no provider');
      const nameless = run(['serve', '--agent', `ollama/${MODEL}`]);
      expect(nameless.status).not.toBe(0);
      expect(nameless.stderr).toContain('write it as name=model');
    });
  }
);
