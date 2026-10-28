import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';
import { getOllamaUrl, getTestModel, ollamaSkipReason } from '../../helpers/setup';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.tmp-headless-e2e', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI without blocking, so the fake Ollama of this process can answer it */
function cli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const user = (content: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } });

describe('cogitator run -p (fake Ollama)', () => {
  let ollama: FakeOllama;
  let workDir: string;
  let env: NodeJS.ProcessEnv;
  const model = ['-m', 'ollama/fake-model'];

  beforeAll(async () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    ollama = await startFakeOllama(
      (messages) => {
        const last = messages.at(-1)?.content ?? '';
        if (last.includes('color')) return { content: '{"color":"teal"}' };
        const turns = messages.filter((message) => message.role === 'user').length;
        return { content: `turn ${turns}: ${last}` };
      },
      ['fake-model']
    );
  });

  afterAll(async () => {
    await ollama.close();
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(SCRATCH_ROOT, 'run-'));
    writeFileSync(join(workDir, 'cogitator.yml'), 'logging:\n  level: debug\n');
    env = {
      OLLAMA_URL: ollama.url,
      OLLAMA_HOST: '',
      OLLAMA_API_KEY: '',
      COGITATOR_MODEL: '',
      COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
    };
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('prints the answer alone on stdout, logs going to stderr', async () => {
    const result = await cli(['run', '-p', ...model, 'hello'], workDir, env);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('turn 1: hello\n');
    expect(result.stderr).toContain('Using config');
  });

  it('reads the prompt from stdin', async () => {
    const result = await cli(['run', '-p', ...model], workDir, env, 'from stdin\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('turn 1: from stdin\n');
  });

  it('answers json, and resumes and forks the session in later processes', async () => {
    const first = await cli(
      ['run', '-p', ...model, '--output-format', 'json', '--session-id', 'e2e-s', 'one'],
      workDir,
      env
    );
    expect(first.status).toBe(0);
    const [result] = jsonLines(first.stdout);
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'e2e-s',
      result: 'turn 1: one',
    });

    const resumed = await cli(['run', '-p', ...model, '--resume', 'e2e-s', 'two'], workDir, env);
    expect(resumed.stdout).toBe('turn 2: two\n');

    const forked = await cli(
      [
        'run',
        '-p',
        ...model,
        '--resume',
        'e2e-s',
        '--fork',
        '--session-id',
        'e2e-fork',
        '--output-format',
        'json',
        'three',
      ],
      workDir,
      env
    );
    expect(jsonLines(forked.stdout)[0]).toMatchObject({
      session_id: 'e2e-fork',
      result: 'turn 3: three',
    });

    const missing = await cli(['run', '-p', ...model, '--resume', 'nope', 'x'], workDir, env);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('Session nope does not exist');
  });

  it('streams stream-json turns from stream-json input', async () => {
    const result = await cli(
      [
        'run',
        '-p',
        ...model,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--session-id',
        'sj',
      ],
      workDir,
      env,
      `${user('first')}\n${user('second')}\n`
    );
    expect(result.status).toBe(0);
    const lines = jsonLines(result.stdout);
    expect(lines.every((line) => line.session_id === 'sj')).toBe(true);
    expect(lines.every((line) => line.type === 'result' || line.parent_tool_use_id === null)).toBe(
      true
    );
    expect(lines.filter((line) => line.type === 'result').map((line) => line.result)).toEqual([
      'turn 1: first',
      'turn 2: second',
    ]);
    expect(lines[0]).toMatchObject({ type: 'start', threadId: 'sj' });
    expect(lines.map((line) => line.type)).toContain('text-delta');
  });

  it('answers with structured output for --json-schema', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: { color: { type: 'string' } },
      required: ['color'],
    });
    const result = await cli(
      ['run', '-p', ...model, '--json-schema', schema, 'Pick a color'],
      workDir,
      env
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ color: 'teal' });
  });

  it('exits 2 for flags that do not go together', async () => {
    for (const args of [
      ['run', '--output-format', 'json', 'x'],
      ['run', '-p', '--fork', 'x'],
      ['run', '-p', '--input-format', 'stream-json', 'x'],
      ['run', '-p', '--json-schema', '{broken', 'x'],
      ['run', '-p', '--output-format', 'yaml', 'x'],
    ]) {
      const result = await cli([...args, ...model], workDir, env);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stdout).toBe('');
    }
  });

  it('keeps the session in the process only with --no-session-persistence', async () => {
    const result = await cli(
      ['run', '-p', ...model, '--no-session-persistence', '--session-id', 'gone', 'hi'],
      workDir,
      env
    );
    expect(result.status).toBe(0);
    const later = await cli(['run', '-p', ...model, '--resume', 'gone', 'again'], workDir, env);
    expect(later.status).toBe(1);
  });
});

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

describeOllama('cogitator run -p (Ollama)', () => {
  let workDir: string;

  beforeAll(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    workDir = mkdtempSync(join(SCRATCH_ROOT, 'ollama-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('streams a real turn as stream-json and ends with a result', async () => {
    const result = await cli(
      [
        'run',
        '-p',
        '-m',
        `ollama/${getTestModel()}`,
        '--output-format',
        'stream-json',
        'Reply with one word: pong',
      ],
      workDir,
      {
        OLLAMA_URL: getOllamaUrl(),
        OLLAMA_HOST: '',
        OLLAMA_API_KEY: '',
        COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
      }
    );
    expect(result.status).toBe(0);
    const lines = jsonLines(result.stdout);
    const last = lines.at(-1);
    expect(last).toMatchObject({ type: 'result', subtype: 'success' });
    expect(String(last?.result).trim().length).toBeGreaterThan(0);
  });
});
