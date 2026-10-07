import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProject, writeFiles, writeLock } from 'create-cogitator-app';
import { addChangesFrom } from '../utils/add.js';
import { runAdd } from '../commands/add.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-add-'));
  dirs.push(dir);
  const plan = planProject({
    name: 'add-test',
    app: 'script',
    memory: 'none',
    provider: 'openai',
    model: 'gpt-6.1-sol',
    packageManager: 'pnpm',
  });
  await writeFiles(dir, plan.files);
  await writeLock(
    dir,
    plan.files.map((file) => file.path)
  );
  return dir;
}

function captureOutput(): () => string {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return () => lines.join('\n');
}

describe('addChangesFrom', () => {
  it('reads features, comma lists and flags', () => {
    expect(
      addChangesFrom(['rag,evals', 'mcp'], {
        memory: 'postgres',
        deploy: 'docker',
        agent: ['claude'],
      })
    ).toEqual({
      features: ['rag', 'evals', 'mcp'],
      channels: [],
      codingAgents: ['claude'],
      memory: 'postgres',
      deploy: 'docker',
    });
  });

  it('suggests the closest name for a typo', () => {
    expect(() => addChangesFrom(['workflow'], {})).toThrow('Did you mean "workflows"?');
    expect(() => addChangesFrom([], { memory: 'postgress' })).toThrow('Did you mean "postgres"?');
  });

  it('asks for something to add', () => {
    expect(() => addChangesFrom([], {})).toThrow(/Name what to add/);
  });
});

describe('cogitator add', () => {
  it('prints the plan with diffs on --dry-run and writes nothing', async () => {
    const dir = await project();
    const output = captureOutput();

    const code = await runAdd(dir, ['rag'], { dryRun: true });

    expect(code).toBe(0);
    expect(output()).toContain('Adding feature rag');
    expect(output()).toContain('src/rag/knowledge-base.ts');
    expect(output()).toContain('+++ b/src/tools/index.ts');
    expect(existsSync(join(dir, 'src/rag/knowledge-base.ts'))).toBe(false);
  });

  it('adds the feature and reports what to do next', async () => {
    const dir = await project();
    const output = captureOutput();

    const code = await runAdd(dir, ['rag'], { install: false });

    expect(code).toBe(0);
    expect(existsSync(join(dir, 'src/rag/knowledge-base.ts'))).toBe(true);
    expect(output()).toContain('pnpm install');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    expect(manifest.cogitator.spec.features).toEqual(['rag']);

    const again = await runAdd(dir, ['rag'], { install: false });
    expect(again).toBe(0);
    expect(output()).toContain('already has everything asked for');
  });

  it('exits 1 with the diff of every conflicting file', async () => {
    const dir = await project();
    writeFileSync(join(dir, 'src/tools/index.ts'), 'export const tools = [];\n');
    const output = captureOutput();

    const code = await runAdd(dir, ['rag'], { install: false });

    expect(code).toBe(1);
    expect(output()).toContain('src/tools/index.ts');
    expect(output()).toContain('nothing was written');
    expect(existsSync(join(dir, 'src/rag/knowledge-base.ts'))).toBe(false);
  });

  it('prints machine-readable JSON', async () => {
    const dir = await project();
    const output = captureOutput();

    const code = await runAdd(dir, ['workflows'], { json: true, install: false });

    expect(code).toBe(0);
    const parsed = JSON.parse(output());
    expect(parsed).toMatchObject({ ok: true, upToDate: false, added: ['feature workflows'] });
    expect(parsed.written).toContain('src/workflows/report.ts');
    expect(parsed.install).toEqual({ status: 'skipped', reason: 'install was turned off' });
  });
});
