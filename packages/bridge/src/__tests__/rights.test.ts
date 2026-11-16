import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsRights } from '../rights';
import { DEFAULT_LIMITS, type BridgeJob, type PermissionAsk, type Rights } from '../types';
import { agentRecord, at, tempDir } from './helpers';

let project: string;
let remove: () => void;

beforeEach(() => {
  const temp = tempDir();
  project = realpathSync(temp.dir);
  remove = temp.remove;
  mkdirSync(join(project, '.claude'));
});

afterEach(() => {
  remove();
});

function settings(permissions: Record<string, unknown>, file = 'settings.json'): void {
  writeFileSync(join(project, '.claude', file), JSON.stringify({ permissions }));
}

function job(): BridgeJob {
  return {
    number: 1,
    title: 'Ship the fix',
    from: 'claude@demo',
    to: 'codex@demo',
    project,
    cwd: project,
    checks: [],
    budget: DEFAULT_LIMITS.budget,
    lettersUsed: 1,
    depth: 1,
    createdAt: at(),
    deadlineAt: at(3_600_000),
    taskId: 'task-1',
    state: 'working',
    updatedAt: at(),
  };
}

/** What the rules of the project make of a call, for a delegator in `mode`. */
function rights(ask: PermissionAsk, mode?: string): Promise<Rights> | Rights {
  const judge = settingsRights({ settings: { userDirs: [], managedDirs: [] } });
  return judge({
    job: job(),
    delegator: agentRecord({ project, cwd: project, ...(mode && { permissionMode: mode }) }),
    ask,
  });
}

const run = (command: string): PermissionAsk => ({
  tool: 'Bash',
  access: 'command',
  command,
  cwd: project,
});
const edit = (...paths: string[]): PermissionAsk => ({ tool: 'Edit', access: 'edit', paths });
const read = (...paths: string[]): PermissionAsk => ({ tool: 'Read', access: 'read', paths });

describe('the rights the settings of a project give', () => {
  it("make a command a rule allows the agent's own, forbid what a rule denies, and leave the rest to the person", async () => {
    settings({ allow: ['Bash(git push *)'], deny: ['Bash(rm *)'] });

    expect(await rights(run('git push origin main'))).toBe('allow');
    expect(await rights(run('rm -rf build'))).toBe('deny');
    expect(await rights(run('pnpm publish'))).toBe('ask');
  });

  it('judge every command of a line: one the rules do not allow leaves it to the person', async () => {
    settings({ allow: ['Bash(git push *)'], deny: ['Bash(rm *)'] });

    expect(await rights(run('git push origin main && pnpm publish'))).toBe('ask');
    expect(await rights(run('git push origin main && rm -rf build'))).toBe('deny');
  });

  it('follow the mode the agent runs in', async () => {
    const file = join(project, 'src', 'limiter.ts');

    expect(await rights(edit(file))).toBe('ask');
    expect(await rights(edit(file), 'acceptEdits')).toBe('allow');
    expect(await rights(edit(file), 'plan')).toBe('deny');
    expect(await rights(run('pnpm publish'), 'dontAsk')).toBe('deny');
    expect(await rights(run('pnpm publish'), 'bypassPermissions')).toBe('allow');
    expect(await rights(edit(file), 'a mode of some other harness')).toBe('ask');
  });

  it('let files be read, except the ones a rule keeps away', async () => {
    settings({ deny: ['Read(.env)'] });

    expect(await rights(read(join(project, 'README.md')))).toBe('allow');
    expect(await rights(read(join(project, '.env')))).toBe('deny');
  });

  it('know a file by its real path, however the call reached it', async () => {
    if (process.platform === 'win32') return;
    settings({ deny: ['Read(.env)'], allow: ['Edit(src/**)'] });
    writeFileSync(join(project, '.env'), 'KEY=1');
    mkdirSync(join(project, 'src'));
    symlinkSync(project, join(project, 'again'));
    symlinkSync(join(project, '.env'), join(project, 'src', 'harmless.txt'));

    symlinkSync(join(project, '.env'), join(project, '.env.link'));

    expect(await rights(read(join(project, 'again', '.env')))).toBe('deny');
    expect(await rights(read(join(project, 'src', 'harmless.txt')))).toBe('deny');
    expect(await rights(edit(join(project, 'src', 'limiter.ts')))).toBe('allow');
    expect(await rights(edit(join(project, 'again', 'src', 'limiter.ts')))).toBe('ask');
  });

  it('hold a rule that names a link for the link, and for what it points at', async () => {
    if (process.platform === 'win32') return;
    settings({ deny: ['Read(.env)'] });
    writeFileSync(join(project, '.env.development'), 'KEY=1');
    symlinkSync(join(project, '.env.development'), join(project, '.env'));

    expect(await rights(read(join(project, '.env')))).toBe('deny');
    expect(await rights(read(join(project, '.env.development')))).toBe('allow');
  });

  it('leave to the person what a person at a session would be asked: a file outside the project, an address', async () => {
    const outside = join(project, '..', 'elsewhere', 'id_rsa');
    const fetch = (url: string): PermissionAsk => ({ tool: 'WebFetch', access: 'fetch', url });

    expect(await rights(read(outside))).toBe('ask');
    expect(await rights(read(join(project, 'README.md'), outside))).toBe('ask');
    expect(await rights(fetch('https://example.com/page'))).toBe('ask');

    settings({
      allow: ['WebFetch(domain:example.com)'],
      additionalDirectories: [join(project, '..', 'elsewhere')],
    });
    expect(await rights(fetch('https://example.com/page'))).toBe('allow');
    expect(await rights(fetch('https://other.example.org'))).toBe('ask');
    expect(await rights(read(outside))).toBe('allow');
  });

  it('hold a rule that names a tool for the calls of that tool, whatever a harness calls it', async () => {
    settings({ deny: ['Write', 'Grep'], allow: ['Edit(src/**)'] });
    const file = join(project, 'src', 'limiter.ts');

    expect(await rights({ tool: 'Write', access: 'edit', paths: [file] })).toBe('deny');
    expect(await rights({ tool: 'write_file', access: 'edit', paths: [file] })).toBe('deny');
    expect(await rights({ tool: 'Edit', access: 'edit', paths: [file] })).toBe('allow');
    expect(await rights({ tool: 'Grep', access: 'read', paths: [project] })).toBe('deny');
    expect(await rights({ tool: 'Read', access: 'read', paths: [file] })).toBe('allow');
  });

  it('never let an agent allow a change to the settings it is judged by', async () => {
    settings({ allow: ['Edit'] });
    const own = join(project, '.claude', 'settings.local.json');

    expect(await rights(edit(join(project, 'src', 'limiter.ts')))).toBe('allow');
    expect(await rights(edit(own))).toBe('ask');
    expect(await rights(edit(join(project, '.cogitator', 'settings.json')))).toBe('ask');
    expect(await rights(edit(own), 'acceptEdits')).toBe('ask');
    expect(await rights(edit(own), 'bypassPermissions')).toBe('ask');
    expect(await rights(edit(join(project, 'src', 'a.ts'), own), 'bypassPermissions')).toBe('ask');
  });

  it('take an edit rule for the files it names and no others', async () => {
    settings({ allow: ['Edit(src/**)'] });

    expect(await rights(edit(join(project, 'src', 'limiter.ts')))).toBe('allow');
    expect(await rights(edit(join(project, 'package.json')))).toBe('ask');
    expect(
      await rights(edit(join(project, 'src', 'limiter.ts'), join(project, 'package.json')))
    ).toBe('ask');
  });

  it('know a tool they cannot look into only by a rule that names it', async () => {
    const issue: PermissionAsk = { tool: 'mcp__github__create_issue', access: 'other' };

    expect(await rights(issue)).toBe('ask');
    settings({ allow: ['mcp__github'] });
    expect(await rights(issue)).toBe('allow');
    expect(await rights({ tool: 'mcp__slack__post', access: 'other' })).toBe('ask');
    expect(await rights({ tool: 'Bash', access: 'command' })).toBe('ask');
  });

  it('read the local file of the project too, and the mode the settings set', async () => {
    settings({ allow: ['Bash(pnpm test *)'], defaultMode: 'acceptEdits' }, 'settings.local.json');

    expect(await rights(run('pnpm test --run'))).toBe('allow');
    expect(await rights(edit(join(project, 'src', 'limiter.ts')))).toBe('allow');
    expect(await rights(edit(join(project, 'src', 'limiter.ts')), 'default')).toBe('ask');
  });
});
