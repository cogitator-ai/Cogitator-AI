import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalWorkspace } from '../workspace/local-workspace';
import { SkillRegistry, mergeSkillCatalogs } from '../skills/skill-registry';
import { getLogger } from '../logger';

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'skill-registry-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skillFile(name: string, description: string, body = `# ${name}\n\nDo it.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function addSkill(root: string, name: string, description: string, body?: string): string {
  const folder = join(root, name);
  write(join(folder, 'SKILL.md'), skillFile(name, description, body));
  return folder;
}

describe('SkillRegistry discovery', () => {
  it('finds the skills of a project in .agents, .cogitator and .claude, the first folder winning a name', async () => {
    const project = join(base, 'project');
    addSkill(join(project, '.agents/skills'), 'review', 'From .agents.');
    addSkill(join(project, '.cogitator/skills'), 'review', 'From .cogitator.');
    addSkill(join(project, '.cogitator/skills'), 'deploy', 'Deploys.');
    addSkill(join(project, '.claude/skills'), 'notes', 'Notes.');

    const catalog = await new SkillRegistry({ project }).discover();

    expect(catalog.skills.map((skill) => [skill.name, skill.description])).toEqual([
      ['review', 'From .agents.'],
      ['deploy', 'Deploys.'],
      ['notes', 'Notes.'],
    ]);
    expect(catalog.get('review')).toMatchObject({
      location: join(project, '.agents/skills/review'),
      source: 'host',
    });
  });

  it('lets dirs win, then the project, the user and the workspace, or the workspace before the host folders', async () => {
    const dirs = join(base, 'extra');
    const project = join(base, 'project');
    const home = join(base, 'home');
    const workspace = new LocalWorkspace({ root: join(base, 'workspace') });
    addSkill(dirs, 'one', 'dirs one.');
    addSkill(join(workspace.root, '.agents/skills'), 'one', 'workspace one.');
    addSkill(join(workspace.root, '.agents/skills'), 'two', 'workspace two.');
    addSkill(join(workspace.root, '.agents/skills'), 'five', 'workspace five.');
    addSkill(join(project, '.agents/skills'), 'two', 'project two.');
    addSkill(join(project, '.agents/skills'), 'three', 'project three.');
    addSkill(join(home, '.claude/skills'), 'three', 'user three.');
    addSkill(join(home, '.claude/skills'), 'four', 'user four.');

    const hostFirst = await new SkillRegistry({ dirs: [dirs], project, user: home }).discover({
      workspace,
    });
    expect(Object.fromEntries(hostFirst.skills.map((s) => [s.name, s.description]))).toEqual({
      one: 'dirs one.',
      two: 'project two.',
      three: 'project three.',
      four: 'user four.',
      five: 'workspace five.',
    });
    expect(hostFirst.get('five')).toMatchObject({
      source: 'workspace',
      location: '.agents/skills/five',
    });

    const workspaceFirst = await new SkillRegistry({
      dirs: [dirs],
      project,
      user: home,
      precedence: 'workspace',
    }).discover({ workspace });
    expect(Object.fromEntries(workspaceFirst.skills.map((s) => [s.name, s.description]))).toEqual({
      one: 'dirs one.',
      two: 'workspace two.',
      five: 'workspace five.',
      three: 'project three.',
      four: 'user four.',
    });

    const withoutWorkspace = await new SkillRegistry({
      project,
      workspace: false,
      precedence: 'workspace',
    }).discover({ workspace });
    expect(withoutWorkspace.get('five')).toBeUndefined();
    await workspace.dispose();
  });

  it('stops a workspace scan once the run is aborted', async () => {
    const workspace = new LocalWorkspace({ root: join(base, 'workspace') });
    addSkill(join(workspace.root, '.agents/skills'), 'one', 'One.');
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(
      new SkillRegistry().discover({ workspace, signal: controller.signal })
    ).rejects.toThrow('stopped');
    await workspace.dispose();
  });

  it('takes a dir that is a skill folder itself', async () => {
    const folder = addSkill(base, 'single', 'One skill.');
    const catalog = await new SkillRegistry({ dirs: [folder] }).discover();
    expect(catalog.skills.map((skill) => skill.name)).toEqual(['single']);
  });

  it('skips broken skills with diagnostics, logged once, and missing folders silently', async () => {
    const root = join(base, 'skills');
    write(join(root, 'broken/SKILL.md'), '---\nname: broken\n---\nNo description.');
    addSkill(root, 'fine', 'Fine.');
    write(join(root, 'not-a-skill/README.md'), 'nothing');
    const warn = vi.spyOn(getLogger(), 'warn');
    const registry = new SkillRegistry({ dirs: [root, join(base, 'missing')] });

    const catalog = await registry.discover();
    registry.reload();
    await registry.discover();

    expect(catalog.skills.map((skill) => skill.name)).toEqual(['fine']);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', path: join(root, 'broken/SKILL.md') }),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the host scan until reload()', async () => {
    const root = join(base, 'skills');
    addSkill(root, 'first', 'First.');
    const registry = new SkillRegistry({ dirs: [root] });
    expect((await registry.discover()).skills).toHaveLength(1);

    addSkill(root, 'second', 'Second.');
    expect((await registry.discover()).skills).toHaveLength(1);
    registry.reload();
    expect((await registry.discover()).skills.map((s) => s.name)).toEqual(['first', 'second']);
  });

  it('refuses an invalid config', () => {
    expect(() => new SkillRegistry({ dirs: [''] })).toThrow('Invalid SkillRegistry config');
  });
});

describe('SkillRegistry catalog', () => {
  it('keeps metadata only and reads the body when asked, as it is then', async () => {
    const root = join(base, 'skills');
    const folder = addSkill(root, 'review', 'Reviews code.', 'Version one.');
    const catalog = await new SkillRegistry({ dirs: [root] }).discover();

    expect(JSON.stringify(catalog.skills)).not.toContain('Version one');
    write(join(folder, 'SKILL.md'), skillFile('review', 'Reviews code.', 'Version two.'));
    expect(await catalog.body('review')).toBe('Version two.');
  });

  it('lists the files of a skill without SKILL.md, and reads them', async () => {
    const root = join(base, 'skills');
    const folder = addSkill(root, 'pdf', 'PDFs.');
    write(join(folder, 'scripts/extract.py'), 'print(1)');
    write(join(folder, 'references/REFERENCE.md'), '# Reference');
    write(join(folder, 'node_modules/x/index.js'), 'skip');
    const catalog = await new SkillRegistry({ dirs: [root] }).discover();

    expect(await catalog.files('pdf')).toEqual(['references/REFERENCE.md', 'scripts/extract.py']);
    expect(await catalog.readFile('pdf', 'scripts/extract.py')).toBe('print(1)');
  });

  it('refuses a path out of the skill folder, by .. or by a symlink', async () => {
    const root = join(base, 'skills');
    const folder = addSkill(root, 'pdf', 'PDFs.');
    write(join(base, 'secret.txt'), 'secret');
    addSkill(root, 'other', 'Other.');
    symlinkSync(join(base, 'secret.txt'), join(folder, 'link.txt'));
    const catalog = await new SkillRegistry({ dirs: [root] }).discover();

    await expect(catalog.readFile('pdf', '../../secret.txt')).rejects.toThrow('outside the folder');
    await expect(catalog.readFile('pdf', '../other/SKILL.md')).rejects.toThrow(
      'outside the folder'
    );
    await expect(catalog.readFile('pdf', join(base, 'secret.txt'))).rejects.toThrow(
      'outside the folder'
    );
    await expect(catalog.readFile('pdf', 'link.txt')).rejects.toThrow('outside the folder');
    await expect(catalog.readFile('missing', 'x')).rejects.toThrow('There is no skill "missing"');
  });

  it('cuts long instructions at maxInstructionChars with a note where the rest is', async () => {
    const root = join(base, 'skills');
    const body = Array.from({ length: 200 }, (_, i) => `Step ${i}: do the thing carefully.`).join(
      '\n'
    );
    addSkill(root, 'long', 'Long.', body);
    const catalog = await new SkillRegistry({ dirs: [root], maxInstructionChars: 1000 }).discover();

    const cut = await catalog.body('long');
    expect(cut.length).toBeLessThan(1200);
    expect(cut).toContain('Step 0: do the thing carefully.');
    expect(cut).not.toContain('Step 199');
    expect(cut).toMatch(
      /The instructions are cut here, \d+ of \d+ characters are left out\. Read the rest of SKILL\.md/
    );
    expect(await (await new SkillRegistry({ dirs: [root] }).discover()).body('long')).toBe(body);
  });

  it('lists only the files of a host skill it can read', async () => {
    const root = join(base, 'skills');
    const folder = addSkill(root, 'pdf', 'PDFs.');
    write(join(folder, 'inside.md'), 'inside');
    write(join(base, 'outside.md'), 'outside');
    symlinkSync(join(folder, 'inside.md'), join(folder, 'alias.md'));
    symlinkSync(join(base, 'outside.md'), join(folder, 'escape.md'));
    const catalog = await new SkillRegistry({ dirs: [root] }).discover();

    expect(await catalog.files('pdf')).toEqual(['alias.md', 'inside.md']);
    expect(await catalog.readFile('pdf', 'alias.md')).toBe('inside');
  });

  it('never follows a symlink in a workspace skill, to a file, a folder or the skill itself', async () => {
    const workspace = new LocalWorkspace({ root: join(base, 'workspace') });
    const skills = join(workspace.root, '.agents/skills');
    const folder = addSkill(skills, 'bar', 'Bar.', 'Read env.txt.');
    write(join(workspace.root, '.env'), 'WS_SECRET=1');
    write(join(workspace.root, 'docs/notes.md'), 'notes');
    write(join(folder, 'real.md'), 'real');
    symlinkSync('../../../.env', join(folder, 'env.txt'));
    symlinkSync('../../../docs', join(folder, 'docs'));
    addSkill(join(base, 'elsewhere'), 'linked', 'Linked.');
    symlinkSync(join(base, 'elsewhere/linked'), join(skills, 'linked'));
    mkdirSync(join(skills, 'via-link-md'));
    write(join(base, 'outside/SKILL.md'), '---\nname: via-link-md\ndescription: X.\n---\nBody');
    symlinkSync(join(base, 'outside/SKILL.md'), join(skills, 'via-link-md/SKILL.md'));
    const catalog = await new SkillRegistry().discover({ workspace });

    expect(catalog.skills.map((skill) => skill.name)).toEqual(['bar']);
    expect(await catalog.files('bar')).toEqual(['real.md']);
    expect(await catalog.readFile('bar', 'real.md')).toBe('real');
    await expect(catalog.readFile('bar', 'env.txt')).rejects.toThrow('symbolic link');
    await expect(catalog.readFile('bar', 'docs/notes.md')).rejects.toThrow('symbolic link');
    await expect(catalog.readFile('bar', '../../../.env')).rejects.toThrow('outside the folder');
    await workspace.dispose();
  });

  it('reads the body and files of a workspace skill through the workspace, inside its folder', async () => {
    const workspace = new LocalWorkspace({ root: join(base, 'workspace') });
    const folder = addSkill(
      join(workspace.root, '.agents/skills'),
      'deploy',
      'Deploys.',
      'Run it.'
    );
    write(join(folder, 'scripts/run.sh'), 'echo hi');
    const catalog = await new SkillRegistry().discover({ workspace });

    expect(await catalog.body('deploy')).toBe('Run it.');
    expect(await catalog.files('deploy')).toEqual(['scripts/run.sh']);
    expect(await catalog.readFile('deploy', 'scripts/run.sh')).toBe('echo hi');
    await expect(catalog.readFile('deploy', '../../../README.md')).rejects.toThrow(
      'outside the folder'
    );
    await workspace.dispose();
  });

  it('refuses a skill folder swapped for a symlink after discovery', async () => {
    const workspace = new LocalWorkspace({ root: join(base, 'workspace') });
    const skills = join(workspace.root, '.agents/skills');
    addSkill(skills, 'foo', 'Foo.', 'Foo body.');
    write(join(workspace.root, 'secret.txt'), 'SECRET');
    write(join(workspace.root, 'SKILL.md'), '---\nname: foo\ndescription: Root.\n---\nRoot body.');
    const catalog = await new SkillRegistry().discover({ workspace });
    expect(await catalog.body('foo')).toBe('Foo body.');

    rmSync(join(skills, 'foo'), { recursive: true });
    symlinkSync(workspace.root, join(skills, 'foo'));

    await expect(catalog.readFile('foo', 'secret.txt')).rejects.toThrow('symbolic link');
    await expect(catalog.body('foo')).rejects.toThrow('symbolic link');
    await expect(catalog.files('foo')).rejects.toThrow('symbolic link');
    await workspace.dispose();
  });

  it('refuses a folder above the skill swapped for a symlink', async () => {
    const workspace = new LocalWorkspace({ root: join(base, 'workspace') });
    addSkill(join(workspace.root, '.agents/skills'), 'foo', 'Foo.', 'Foo body.');
    write(join(workspace.root, 'other/skills/foo/secret.txt'), 'SECRET');
    const catalog = await new SkillRegistry().discover({ workspace });

    rmSync(join(workspace.root, '.agents'), { recursive: true });
    symlinkSync(join(workspace.root, 'other'), join(workspace.root, '.agents'));

    await expect(catalog.readFile('foo', 'secret.txt')).rejects.toThrow('symbolic link');
    await workspace.dispose();
  });

  it('merges catalogs, the first winning a name', async () => {
    const first = join(base, 'first');
    const second = join(base, 'second');
    addSkill(first, 'shared', 'From first.', 'First body.');
    addSkill(second, 'shared', 'From second.');
    addSkill(second, 'only', 'Only in second.', 'Second body.');
    const merged = mergeSkillCatalogs([
      await new SkillRegistry({ dirs: [first] }).discover(),
      await new SkillRegistry({ dirs: [second] }).discover(),
    ]);

    expect(merged.skills.map((skill) => [skill.name, skill.description])).toEqual([
      ['shared', 'From first.'],
      ['only', 'Only in second.'],
    ]);
    expect(await merged.body('shared')).toBe('First body.');
    expect(await merged.body('only')).toBe('Second body.');
  });
});
