import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import { exactMatch } from '../metrics/deterministic';
import { RunStore } from '../runs';
import type { EvalRun } from '../runs';

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

  it('ignores other files and throws on a run file that is not valid', async () => {
    const store = new RunStore(dir);
    store.save(await suite('qa', 'yes').run());
    writeFileSync(join(dir, 'baseline.json'), '{"exactMatch": 1}');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, 'broken.json'), '{nope');

    expect(store.list()).toHaveLength(1);

    writeFileSync(join(dir, 'bad.json'), '{"format": "cogitator.eval-run", "version": 1}');
    expect(() => store.list()).toThrow(/bad\.json is not a valid eval run file/);
  });

  it('loads by id and refuses ids that are missing or not ids', () => {
    const store = new RunStore(dir);
    writeFileSync(join(dir, 'other.json'), '{"exactMatch": 1}');

    expect(() => store.load('nope')).toThrow(`No run 'nope' in ${dir}`);
    expect(() => store.load('other')).toThrow(/No run 'other'/);
    expect(() => store.load('../escape')).toThrow(/is not a run id/);
  });

  it('lists nothing for a directory that does not exist yet', () => {
    const store = new RunStore(join(dir, 'later'));

    expect(store.list()).toEqual([]);
    expect(store.latest()).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
});
