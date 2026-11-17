import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkName, runCheck, skippedCheck, summarizeChecks } from '../checks';

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-checks-')));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('a check of a job', () => {
  it('passes when its command exits with 0, in the folder it was given', async () => {
    const result = await runCheck(
      { name: 'where', command: 'pwd && echo to-stderr >&2' },
      { cwd: scratch, timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({ name: 'where', command: 'pwd && echo to-stderr >&2', ok: true });
    expect(result.code).toBe(0);
    expect(result.output?.split('\n').sort()).toEqual([scratch, 'to-stderr'].sort());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with the exit code of its command and the end of what it printed', async () => {
    const result = await runCheck(
      { command: 'i=0; while [ $i -lt 3000 ]; do echo "line $i"; i=$((i+1)); done; exit 7' },
      { cwd: scratch, timeoutMs: 20_000 }
    );

    expect(result).toMatchObject({ ok: false, code: 7 });
    expect(result.output?.startsWith('...')).toBe(true);
    expect(result.output?.endsWith('line 2999')).toBe(true);
    expect(result.output?.length).toBeLessThanOrEqual(4_003);
    expect(checkName({ command: 'pnpm test' })).toBe('pnpm test');
  });

  it('is ended with what it started when it runs too long, or when it is told to stop', async () => {
    const slow = await runCheck(
      { command: 'sleep 30 & sleep 30' },
      { cwd: scratch, timeoutMs: 200 }
    );
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    expect(slow.durationMs).toBeLessThan(5_000);

    const stop = new AbortController();
    const running = runCheck(
      { command: 'sleep 30' },
      { cwd: scratch, timeoutMs: 60_000, signal: stop.signal }
    );
    setTimeout(() => stop.abort(), 100);
    expect(await running).toMatchObject({ ok: false, skipped: 'the checks were stopped' });

    expect(
      await runCheck({ command: 'true' }, { cwd: scratch, timeoutMs: 1_000, signal: stop.signal })
    ).toMatchObject({ ok: false, skipped: 'the checks were stopped' });
  });

  it('kills what ignores the request to stop, and ends only when it is gone', async () => {
    writeFileSync(
      join(scratch, 'stubborn.js'),
      "process.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync('pid', String(process.pid));\nsetInterval(() => {}, 1000);\n"
    );

    const result = await runCheck(
      { command: `${JSON.stringify(process.execPath)} stubborn.js & sleep 30` },
      { cwd: scratch, timeoutMs: 500 }
    );

    expect(result).toMatchObject({ ok: false, timedOut: true });
    const pid = Number(readFileSync(join(scratch, 'pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it('is not kept waiting by a process its command left behind', async () => {
    const before = Date.now();
    const result = await runCheck(
      { command: '(sleep 20 &) ; echo started' },
      { cwd: scratch, timeoutMs: 10_000 }
    );

    expect(result).toMatchObject({ ok: true, code: 0, output: 'started' });
    expect(Date.now() - before).toBeLessThan(5_000);
  });

  it('is not run in a folder that is not there', async () => {
    const gone = join(scratch, 'gone');
    expect(await runCheck({ command: 'true' }, { cwd: gone, timeoutMs: 1_000 })).toEqual({
      name: 'true',
      command: 'true',
      ok: false,
      skipped: `the folder ${gone} is not there`,
    });
  });
});

describe('what the checks of a job showed', () => {
  it('is verified only when every check ran and passed', () => {
    expect(
      summarizeChecks([{ name: 'a', command: 'a', ok: true, code: 0, durationMs: 240 }])
    ).toEqual({ verified: true, summary: 'Verified: the check passed.\n- passed: a (0.2 s)' });
    expect(summarizeChecks([])).toMatchObject({ verified: false });
    expect(
      summarizeChecks([
        { name: 'a', command: 'a', ok: true, code: 0, durationMs: 45_400 },
        { name: 'b', command: 'b', ok: false, code: 1, durationMs: 300_000, output: 'boom' },
        { name: 'c', command: 'c', ok: false, code: null, durationMs: 10 },
        { name: 'd', command: 'd', ok: false, timedOut: true, code: null, durationMs: 600_000 },
        skippedCheck({ command: 'e' }, 'not allowed'),
      ])
    ).toEqual({
      verified: false,
      summary: [
        'Not verified: 1 of 5 checks passed.',
        '- passed: a (45 s)',
        '- failed: b: exit code 1 (5 min)',
        '- failed: c: was ended by a signal (0.0 s)',
        '- failed: d: did not end in time (10 min)',
        '- not run: e: not allowed',
        'The end of what "b" printed:',
        'boom',
      ].join('\n'),
    });
  });
});
