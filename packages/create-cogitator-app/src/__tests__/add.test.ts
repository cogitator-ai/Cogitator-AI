import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddConflictError, addToProject, NotAScaffoldedProjectError, planAdd } from '../kit/add.js';
import { IncompatibleSpecError } from '../kit/compat.js';
import { planProject } from '../kit/plan.js';
import { hashContent, LOCK_PATH, readLock, writeFiles, writeLock } from '../kit/scaffold.js';
import type { ProjectSpecInput } from '../kit/spec.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const spec: ProjectSpecInput = {
  name: 'demo',
  preset: 'basic',
  app: 'script',
  memory: 'none',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  packageManager: 'pnpm',
};

/** A project as the scaffolder leaves it, without installing anything. */
async function scaffolded(overrides: Partial<ProjectSpecInput> = {}, lock = true): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'cca-add-'));
  roots.push(directory);
  const plan = planProject({ ...spec, ...overrides });
  await writeFiles(directory, plan.files);
  if (lock)
    await writeLock(
      directory,
      plan.files.map((file) => file.path)
    );
  return directory;
}

function read(directory: string, path: string): string {
  return readFileSync(join(directory, path), 'utf-8');
}

function manifest(directory: string): {
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  cogitator: { spec: { features: string[]; memory: string }; command: string };
} {
  return JSON.parse(read(directory, 'package.json'));
}

describe('planAdd', () => {
  it('plans the files, dependencies and variables a feature brings', async () => {
    const directory = await scaffolded();
    const plan = planAdd(directory, { features: ['rag'] });

    expect(plan.upToDate).toBe(false);
    expect(plan.summary).toEqual(['feature rag']);
    expect(plan.conflicts).toEqual([]);
    const byPath = new Map(plan.changes.map((change) => [change.path, change]));
    expect(byPath.get('src/rag/knowledge-base.ts')?.kind).toBe('create');
    expect(byPath.get('src/tools/index.ts')?.kind).toBe('update');
    expect(byPath.get('src/tools/index.ts')?.diff).toContain('+++ b/src/tools/index.ts');
    expect(Object.keys(plan.dependencies)).toContain('@cogitator-ai/rag');
    expect(plan.env.map((variable) => variable.name)).toContain('DOCS_DIR');
    expect(plan.command).toContain('--features rag');
  });

  it('is up to date when the project already has the feature', async () => {
    const directory = await scaffolded({ features: ['rag'] });
    const plan = planAdd(directory, { features: ['rag'] });
    expect(plan.upToDate).toBe(true);
    expect(plan.changes).toEqual([]);
  });

  it('refuses a project the scaffolder did not create', async () => {
    const directory = await scaffolded();
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'demo' }));
    expect(() => planAdd(directory, { features: ['rag'] })).toThrow(NotAScaffoldedProjectError);
    expect(() => planAdd(join(directory, 'nowhere'), {})).toThrow(/no package.json/);
  });

  it('refuses an addition that does not fit the project', async () => {
    const directory = await scaffolded();
    expect(() => planAdd(directory, { channels: ['telegram'] })).toThrow(IncompatibleSpecError);
  });
});

describe('addToProject', () => {
  it('adds a feature, records it in package.json and the lock, and is idempotent', async () => {
    const directory = await scaffolded();
    const result = await addToProject(directory, { features: ['rag'] }, { install: false });

    expect(result.written).toContain('src/rag/knowledge-base.ts');
    expect(existsSync(join(directory, 'src/rag/knowledge-base.ts'))).toBe(true);
    expect(read(directory, 'src/tools/index.ts')).toContain('ragSearch');
    const pkg = manifest(directory);
    expect(pkg.dependencies['@cogitator-ai/rag']).toBeDefined();
    expect(pkg.cogitator.spec.features).toEqual(['rag']);
    expect(pkg.cogitator.command).toContain('--features rag');
    const lock = readLock(directory);
    expect(lock?.files['src/rag/knowledge-base.ts']).toBe(
      hashContent(read(directory, 'src/rag/knowledge-base.ts'))
    );

    const fresh = planProject({ ...spec, features: ['rag'] });
    for (const file of fresh.files) {
      if (file.path === '.env') continue;
      expect(read(directory, file.path), file.path).toBe(file.content);
    }

    const again = await addToProject(directory, { features: ['rag'] }, { install: false });
    expect(again.plan.upToDate).toBe(true);
    expect(again.written).toEqual([]);
  });

  it('updates files the formatter changed, since the lock vouches for them', async () => {
    const directory = await scaffolded();
    const formatted = read(directory, 'src/tools/index.ts').replace(/'/g, '"');
    writeFileSync(join(directory, 'src/tools/index.ts'), formatted);
    await writeLock(directory, [
      'src/tools/index.ts',
      ...Object.keys(readLock(directory)?.files ?? {}),
    ]);

    const plan = planAdd(directory, { features: ['rag'] });
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.find((change) => change.path === 'src/tools/index.ts')?.kind).toBe(
      'update'
    );
  });

  it('refuses with a diff when the addition changes a file the user edited, writing nothing', async () => {
    const directory = await scaffolded();
    const edited = `${read(directory, 'src/tools/index.ts')}\n// my own tool goes here\n`;
    writeFileSync(join(directory, 'src/tools/index.ts'), edited);
    const before = read(directory, 'package.json');

    const error = await addToProject(directory, { features: ['rag'] }, { install: false }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(AddConflictError);
    const conflicts = (error as AddConflictError).conflicts;
    expect(conflicts.map((conflict) => conflict.path)).toEqual(['src/tools/index.ts']);
    expect(conflicts[0].reason).toMatch(/you edited it/);
    expect(conflicts[0].diff).toContain('+import { ragSearch }');
    expect(read(directory, 'src/tools/index.ts')).toBe(edited);
    expect(read(directory, 'package.json')).toBe(before);
    expect(existsSync(join(directory, 'src/rag/knowledge-base.ts'))).toBe(false);
  });

  it('keeps edits the addition does not touch', async () => {
    const directory = await scaffolded();
    const edited = `${read(directory, 'src/agents/assistant.ts')}\n// tuned by hand\n`;
    writeFileSync(join(directory, 'src/agents/assistant.ts'), edited);

    await addToProject(directory, { memory: 'sqlite' }, { install: false });

    expect(read(directory, 'src/agents/assistant.ts')).toBe(edited);
    expect(manifest(directory).cogitator.spec.memory).toBe('sqlite');
  });

  it("merges into the user's package.json, cogitator.yml and .gitignore key by key", async () => {
    const directory = await scaffolded();
    const pkg = JSON.parse(read(directory, 'package.json'));
    pkg.dependencies.lodash = '^4.17.21';
    pkg.scripts.seed = 'tsx scripts/seed.ts';
    writeFileSync(join(directory, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const yml = read(directory, 'cogitator.yml').replace(
      'defaultModel: openai/gpt-6.1-sol',
      'defaultModel: openai/gpt-6.1-sol-mini # cheaper'
    );
    writeFileSync(join(directory, 'cogitator.yml'), yml);
    writeFileSync(join(directory, '.gitignore'), `${read(directory, '.gitignore')}secrets/\n`);

    const result = await addToProject(directory, { memory: 'sqlite' }, { install: false });

    const merged = manifest(directory);
    expect(merged.dependencies.lodash).toBe('^4.17.21');
    expect(merged.dependencies['better-sqlite3']).toBeDefined();
    expect(Object.keys(merged.dependencies)).toEqual(Object.keys(merged.dependencies).sort());
    expect(merged.scripts.seed).toBe('tsx scripts/seed.ts');
    const config = read(directory, 'cogitator.yml');
    expect(config).toContain('defaultModel: openai/gpt-6.1-sol-mini # cheaper');
    expect(config).toContain('\nmemory:\n  adapter: sqlite');
    expect(config).toContain('# The Cogitator runtime');
    const ignore = read(directory, '.gitignore');
    expect(ignore).toContain('secrets/\n');
    expect(ignore).toContain('data/\n');
    expect(result.plan.changes.find((change) => change.path === 'cogitator.yml')?.source).toBe(
      'merged'
    );
  });

  it('refuses when the user changed a key the addition changes differently', async () => {
    const directory = await scaffolded({ memory: 'sqlite' });
    writeFileSync(
      join(directory, 'cogitator.yml'),
      read(directory, 'cogitator.yml').replace('adapter: sqlite', 'adapter: memory')
    );

    const plan = planAdd(directory, { memory: 'postgres' });

    expect(plan.conflicts.map((conflict) => conflict.path)).toEqual(['cogitator.yml']);
    expect(plan.conflicts[0].reason).toContain('memory.adapter');
  });

  it('rewrites only the managed block of an edited AGENTS.md', async () => {
    const directory = await scaffolded();
    const agents = read(directory, 'AGENTS.md').replace(
      'Add what agents should know about this project here.',
      'Deploys go through the staging branch.'
    );
    writeFileSync(join(directory, 'AGENTS.md'), agents);

    await addToProject(directory, { features: ['workflows'] }, { install: false });

    const after = read(directory, 'AGENTS.md');
    expect(after).toContain('Deploys go through the staging branch.');
    expect(after).toContain('agents, workflows');
  });

  it('leaves an edited README alone with a note carrying the change', async () => {
    const directory = await scaffolded();
    writeFileSync(join(directory, 'README.md'), '# My assistant\n\nOur own words.\n');

    const result = await addToProject(directory, { features: ['workflows'] }, { install: false });

    expect(read(directory, 'README.md')).toBe('# My assistant\n\nOur own words.\n');
    const note = result.plan.notes.find((entry) => entry.path === 'README.md');
    expect(note?.diff).toContain('+++ b/README.md');
  });

  it('is a conflict when the user deleted a file the addition changes', async () => {
    const directory = await scaffolded();
    unlinkSync(join(directory, 'src/tools/index.ts'));

    const plan = planAdd(directory, { features: ['rag'] });

    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        path: 'src/tools/index.ts',
        reason: expect.stringMatching(/deleted/),
      }),
    ]);
  });

  it('works without a lock for files that are exactly as generated', async () => {
    const directory = await scaffolded({}, false);
    expect(existsSync(join(directory, LOCK_PATH))).toBe(false);

    const plan = planAdd(directory, { deploy: 'docker' });

    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.map((change) => change.path)).toContain('Dockerfile');
    expect(plan.notes.map((note) => note.message).join('\n')).toContain(
      'no .cogitator/scaffold.json'
    );
  });
});
