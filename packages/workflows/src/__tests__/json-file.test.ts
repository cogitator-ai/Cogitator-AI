import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, writeJsonExclusive } from '../json-file';
import { FileRunStore } from '../manager/run-store';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-json-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('replaces the file and leaves no temporary file behind', async () => {
    const dir = temp();
    const file = join(dir, 'run.json');
    await writeJsonAtomic(file, { status: 'running' });
    await writeJsonAtomic(file, { status: 'waiting' });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ status: 'waiting' });
    expect(readdirSync(dir)).toEqual(['run.json']);
  });

  it('lets concurrent writers of one file each land whole', async () => {
    const dir = temp();
    const file = join(dir, 'run.json');
    await Promise.all(Array.from({ length: 25 }, (_, round) => writeJsonAtomic(file, { round })));
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveProperty('round');
    expect(readdirSync(dir)).toEqual(['run.json']);
  });
});

describe('writeJsonExclusive', () => {
  it('keeps the first answer and refuses the second', async () => {
    const dir = temp();
    const file = join(dir, 'response.json');
    await writeJsonExclusive(file, { decision: true });
    await expect(writeJsonExclusive(file, { decision: false })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ decision: true });
    expect(readdirSync(dir)).toEqual(['response.json']);
  });
});

describe('FileRunStore after a crash', () => {
  it('ignores what a killed write left behind and keeps the last whole run', async () => {
    const dir = temp();
    const store = new FileRunStore({ directory: dir, cacheTTL: 0 });
    const run = {
      id: 'r1',
      workflowName: 'publish',
      status: 'waiting' as const,
      state: {},
      currentNodes: [],
      completedNodes: [],
      failedNodes: [],
      startedAt: 1,
      priority: 0,
      tags: [],
    };
    await store.save(run);
    writeFileSync(join(dir, 'r1.json.4242.abc.tmp'), '{"id":"r1","sta');

    const again = new FileRunStore({ directory: dir, cacheTTL: 0 });
    expect(await again.list({ status: ['running', 'waiting'] })).toEqual([run]);
  });

  it('always leaves a run a recovering process can read when the writer is killed', async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rewrite-run.ts');
    for (let attempt = 0; attempt < 30; attempt++) {
      const dir = temp();
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, dir], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('READY') && resolve());
        child.once('exit', (code) => reject(new Error(`the writer exited with ${code}`)));
      });
      await new Promise((resolve) => setTimeout(resolve, 5 + ((attempt * 7) % 23)));
      child.kill('SIGKILL');
      await once(child, 'exit');

      const recovered = await new FileRunStore({ directory: dir, cacheTTL: 0 }).list({
        status: ['running', 'waiting'],
      });
      expect(recovered.map((candidate) => candidate.id)).toEqual(['crash-run']);
    }
  }, 120_000);
});
