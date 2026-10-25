import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PermissionRuleSet,
  addAllowRule,
  loadPermissionSettings,
  rememberFile,
  settingsChanged,
} from '../permissions/index';

let base: string;
let root: string;
let user: string;
let managed: string;

function write(path: string, json: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json));
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'permission-settings-')));
  root = join(base, 'project');
  user = join(base, 'home', '.claude');
  managed = join(base, 'etc', 'claude-code');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const load = (options: Parameters<typeof loadPermissionSettings>[1] = {}) =>
  loadPermissionSettings(root, { userDirs: [user], managedDirs: [managed], ...options });

describe('loadPermissionSettings', () => {
  it('reads every layer, each file on its own, Claude Code and Cogitator files alike', async () => {
    write(join(managed, 'managed-settings.json'), { permissions: { deny: ['Bash(curl *)'] } });
    write(join(managed, 'managed-settings.d', '20-b.json'), {
      permissions: { deny: ['Read(//etc/**)'] },
    });
    write(join(managed, 'managed-settings.d', '10-a.json'), {
      permissions: { ask: ['Bash(git push *)'] },
    });
    write(join(user, 'settings.json'), {
      permissions: { allow: ['Bash(npm test *)'], defaultMode: 'acceptEdits' },
    });
    write(join(root, '.claude', 'settings.json'), {
      permissions: { allow: ['Edit(src/**)'] },
      model: 'x',
    });
    write(join(root, '.cogitator', 'settings.local.json'), {
      permissions: { deny: ['Edit(.env)'] },
    });

    const { layers, warnings } = await load();

    expect(warnings).toEqual([]);
    expect(layers.map((layer) => [layer.layer, layer.origin?.slice(base.length)])).toEqual([
      ['managed', '/etc/claude-code/managed-settings.json'],
      ['managed', '/etc/claude-code/managed-settings.d/10-a.json'],
      ['managed', '/etc/claude-code/managed-settings.d/20-b.json'],
      ['local', '/project/.cogitator/settings.local.json'],
      ['project', '/project/.claude/settings.json'],
      ['user', '/home/.claude/settings.json'],
    ]);
    expect(layers.find((layer) => layer.layer === 'project')?.anchor).toBe(root);
    expect(layers.find((layer) => layer.layer === 'user')?.anchor).toBe(user);
    expect(new PermissionRuleSet(layers).defaultMode()).toBe('acceptEdits');
  });

  it('skips broken files and entries with a warning', async () => {
    write(join(root, '.claude', 'settings.json'), '{ not json');
    write(join(root, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Read', 42], defaultMode: 'yolo' },
    });
    const { layers, warnings } = await load();
    expect(layers).toHaveLength(1);
    expect(layers[0].allow).toEqual(['Read']);
    expect(warnings.join('\n')).toMatch(/not valid JSON/);
    expect(warnings.join('\n')).toMatch(/not a string/);
    expect(warnings.join('\n')).toMatch(/"yolo"/);
  });

  it('keeps a repository from turning prompts off, and an untrusted one from granting', async () => {
    write(join(root, '.claude', 'settings.json'), {
      permissions: {
        defaultMode: 'bypassPermissions',
        allow: ['Bash'],
        deny: ['Bash(rm *)'],
        additionalDirectories: ['../x'],
      },
    });
    const trusted = await load();
    expect(trusted.layers[0].defaultMode).toBeUndefined();
    expect(trusted.warnings.join('\n')).toMatch(/only from user or managed settings/);
    write(join(root, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Read'], deny: ['Read(.env)'], additionalDirectories: ['/'] },
    });
    const untrusted = await load({ trusted: false });
    const local = untrusted.layers.find((layer) => layer.layer === 'local');
    expect(local).toMatchObject({ deny: ['Read(.env)'] });
    expect(local?.allow).toBeUndefined();
    expect(local?.additionalDirectories).toBeUndefined();
    const project = untrusted.layers.find((layer) => layer.layer === 'project');
    expect(project).toMatchObject({ deny: ['Bash(rm *)'] });
    expect(project?.allow).toBeUndefined();
    expect(project?.additionalDirectories).toBeUndefined();
  });

  it('reads only the layers asked for, and lets any layer disable a mode', async () => {
    write(join(user, 'settings.json'), { permissions: { defaultMode: 'bypassPermissions' } });
    write(join(root, '.claude', 'settings.json'), {
      permissions: { disableBypassPermissionsMode: 'disable' },
    });
    const all = new PermissionRuleSet((await load()).layers);
    expect(all.disables('bypassPermissions')).toBe(true);
    expect(all.defaultMode()).toBeUndefined();
    const userOnly = await load({ layers: ['user'] });
    expect(new PermissionRuleSet(userOnly.layers).defaultMode()).toBe('bypassPermissions');
  });
});

describe('addAllowRule', () => {
  it('adds a rule to the file, keeping what it holds, once', async () => {
    const file = rememberFile('local', root);
    expect(file).toBe(join(root, '.cogitator', 'settings.local.json'));
    write(file, { permissions: { deny: ['Bash(rm *)'], allow: ['Read'] }, theme: 'dark' });
    await Promise.all([
      addAllowRule(file, 'Bash(npm test *)'),
      addAllowRule(file, 'Bash(git status)'),
    ]);
    await addAllowRule(file, 'Bash(npm test *)');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      permissions: {
        deny: ['Bash(rm *)'],
        allow: ['Read', 'Bash(npm test *)', 'Bash(git status)'],
      },
      theme: 'dark',
    });
  });

  it('creates a missing file and refuses one that is not an object', async () => {
    const file = rememberFile('project', root);
    await addAllowRule(file, 'Read');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ permissions: { allow: ['Read'] } });
    write(file, '[1]');
    await expect(addAllowRule(file, 'Edit')).rejects.toThrow(/JSON object/);
    expect(rememberFile('user', root, { userDirs: [user] })).toBe(join(user, 'settings.json'));
  });
});

describe('settingsChanged', () => {
  it('notices a drop-in file added after the first read', async () => {
    mkdirSync(managed, { recursive: true });
    const first = await load();
    expect(await settingsChanged(first.files, first.dirs)).toBe(false);
    write(join(managed, 'managed-settings.d', 'deny.json'), { permissions: { deny: ['Bash'] } });
    expect(await settingsChanged(first.files, first.dirs)).toBe(true);
    const second = await load();
    expect(second.layers.some((layer) => layer.deny?.includes('Bash'))).toBe(true);
  });
});
