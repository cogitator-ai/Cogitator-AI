import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import { exactMatch } from '../metrics/deterministic';
import { RunStore } from '../runs';
import type { EvalRun, SkippedRunFile } from '../runs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cogitator-run-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function suite(name: string, answer: string) {
  return new EvalSuite({
    dataset: Dataset.from([
      { input: 'a', expected: 'yes' },
      { input: 'b', expected: 'yes' },
    ]),
    target: { fn: async (input) => (input === 'a' ? 'yes' : answer) },
    metrics: [exactMatch()],
    name,
  });
}

function at(run: EvalRun, runId: string, startedAt: string): EvalRun {
  return { ...run, runId, startedAt, finishedAt: startedAt };
}

describe('RunStore', () => {
  it('saves suite results and runs as <runId>.json, creating the directory', async () => {
    const store = new RunStore(join(dir, 'runs'));
    const result = await suite('qa', 'yes').run();

    const path = store.save(result);
    const second = store.save(at(result.toRun(), 'second', '2030-01-01T00:00:00.000Z'));

    expect(path).toBe(join(dir, 'runs', `${result.runId}.json`));
    expect(second).toBe(join(dir, 'runs', 'second.json'));
    expect(store.load(result.runId)).toEqual(result.toRun());
  });

  it('lists the runs newest first with their metric means', async () => {
    const store = new RunStore(dir);
    const run = (await suite('qa', 'no').run()).toRun();
    store.save(at(run, 'old', '2026-01-01T00:00:00Z'));
    store.save(at(run, 'new', '2026-03-01T00:00:00.000Z'));
    store.save(at(run, 'mid', '2026-02-01T00:00:00.000Z'));

    const list = store.list();

    expect(list.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(list[0]).toEqual({
      id: 'new',
      name: 'qa',
      startedAt: '2026-03-01T00:00:00.000Z',
      finishedAt: '2026-03-01T00:00:00.000Z',
      cases: 2,
      metrics: { exactMatch: 0.5 },
      path: join(dir, 'new.json'),
    });
  });

  it('filters by name or by a predicate, and gives the latest match', async () => {
    const store = new RunStore(dir);
    const qa = (await suite('qa', 'yes').run()).toRun();
    const other = (await suite('other', 'no').run()).toRun();
    store.save(at(qa, 'qa-1', '2026-01-01T00:00:00.000Z'));
    store.save(at(qa, 'qa-2', '2026-01-02T00:00:00.000Z'));
    store.save(at(other, 'other-1', '2026-01-03T00:00:00.000Z'));

    expect(store.list({ name: 'qa' }).map((r) => r.id)).toEqual(['qa-2', 'qa-1']);
    expect(store.latest()?.runId).toBe('other-1');
    expect(store.latest({ name: 'qa' })?.runId).toBe('qa-2');
    expect(store.latest((r) => r.metrics.exactMatch < 1)?.runId).toBe('other-1');
    expect(store.latest({ name: 'missing' })).toBeUndefined();
  });

  it('passes over other JSON and reports the entries it cannot read, listing the rest', async () => {
    const skipped: SkippedRunFile[] = [];
    const store = new RunStore(dir, { onSkip: (entry) => skipped.push(entry) });
    const run = (await suite('qa', 'yes').run()).toRun();
    store.save(run);
    writeFileSync(join(dir, 'baseline.json'), '{"exactMatch": 1}');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, 'broken.json'), '{nope');
    writeFileSync(join(dir, 'edited.json'), JSON.stringify({ ...run, runId: 'edited', stats: 1 }));
    writeFileSync(
      join(dir, 'future.json'),
      JSON.stringify({ ...run, runId: 'future', version: 2 })
    );
    mkdirSync(join(dir, 'folder.json'));

    expect(store.list().map((r) => r.id)).toEqual([run.runId]);
    expect(store.latest()?.runId).toBe(run.runId);
    expect(skipped.map((s) => basename(s.path)).sort()).toEqual([
      'broken.json',
      'broken.json',
      'edited.json',
      'edited.json',
      'folder.json',
      'folder.json',
      'future.json',
      'future.json',
    ]);
    const reasons = Object.fromEntries(skipped.map((s) => [basename(s.path), s.reason]));
    expect(reasons['broken.json']).toBe('not JSON');
    expect(reasons['edited.json']).toMatch(/is not a valid eval run file: stats/);
    expect(reasons['future.json']).toMatch(
      /of version 2, this version of @cogitator-ai\/evals reads version 1/
    );
    expect(reasons['folder.json']).toBe('not a file');
  });

  it('reports skipped entries as process warnings by default', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      writeFileSync(join(dir, 'broken.json'), '{nope');

      expect(new RunStore(dir).list()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(`RunStore skipped ${join(dir, 'broken.json')}: not JSON`, {
        code: 'COGITATOR_EVALS_RUN_SKIPPED',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('loads by id strictly and refuses ids that are missing or not ids', async () => {
    const store = new RunStore(dir, { onSkip: () => {} });
    const run = (await suite('qa', 'yes').run()).toRun();
    writeFileSync(join(dir, 'other.json'), '{"exactMatch": 1}');
    writeFileSync(join(dir, 'future.json'), JSON.stringify({ ...run, version: 2 }));
    mkdirSync(join(dir, 'folder.json'));

    expect(() => store.load('nope')).toThrow(`No run 'nope' in ${dir}`);
    expect(() => store.load('other')).toThrow(/other\.json is not an eval run file/);
    expect(() => store.load('future')).toThrow(/of version 2/);
    expect(() => store.load('folder')).toThrow(/Cannot read the run file/);
    expect(() => store.load('../escape')).toThrow(/is not a run id/);
  });

  it('refuses to save a run whose id would lead outside the directory', async () => {
    const store = new RunStore(join(dir, 'runs'));
    const run = (await suite('qa', 'yes').run()).toRun();

    expect(() => store.save({ ...run, runId: '../escaped' })).toThrow(
      /Cannot write the run: runId/
    );
    expect(() => store.save({ ...run, runId: 'a/b' })).toThrow(/Cannot write the run: runId/);
    expect(existsSync(join(dir, 'escaped.json'))).toBe(false);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('lists nothing for a directory that does not exist yet', () => {
    const store = new RunStore(join(dir, 'later'));

    expect(store.list()).toEqual([]);
    expect(store.latest()).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
});
