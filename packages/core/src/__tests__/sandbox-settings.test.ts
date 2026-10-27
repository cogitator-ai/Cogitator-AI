import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionLayerSettings, SandboxSettingsFile } from '@cogitator-ai/types';
import {
  loadSandboxPolicy,
  readPermissionLayer,
  readSandboxSection,
  sandboxPolicyOf,
  sandboxSettingsPath,
} from '../permissions/index';

const HOME = '/home/dev';
const PROJECT = '/work/project';

function layer(
  name: PermissionLayerSettings['layer'],
  sandbox: SandboxSettingsFile,
  extra: Omit<PermissionLayerSettings, 'layer' | 'sandbox'> = {}
): PermissionLayerSettings {
  const anchor = name === 'project' || name === 'local' ? PROJECT : `/${name}-dir`;
  return { layer: name, origin: `${name}.json`, anchor, sandbox, ...extra };
}

const policyOf = (layers: PermissionLayerSettings[]) => sandboxPolicyOf(layers, { home: HOME });

describe('readSandboxSection', () => {
  it('reads the keys Cogitator supports and warns about the others', () => {
    const warnings: string[] = [];
    const section = readSandboxSection(
      {
        enabled: true,
        autoAllowBashIfSandboxed: false,
        excludedCommands: ['docker *', 3],
        enableWeakerNestedSandbox: true,
        unknownKey: 1,
        filesystem: { allowWrite: ['~/.kube'], disabled: 'yes' },
        network: { allowedDomains: ['github.com'], httpProxyPort: 8080 },
        credentials: {
          envVars: [
            { name: 'NPM_TOKEN', mode: 'deny' },
            { name: 'GH', mode: 'mask' },
          ],
        },
        bwrapPath: 'relative/bwrap',
      },
      'f.json',
      warnings
    );
    expect(section).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: ['docker *'],
      filesystem: { allowWrite: ['~/.kube'] },
      network: { allowedDomains: ['github.com'] },
      credentials: {
        envVars: [
          { name: 'NPM_TOKEN', mode: 'deny' },
          { name: 'GH', mode: 'mask' },
        ],
      },
    });
    expect(warnings.join('\n')).toMatch(/enableWeakerNestedSandbox is not supported/);
    expect(warnings.join('\n')).toMatch(/unknownKey is not a sandbox setting/);
    expect(warnings.join('\n')).toMatch(/httpProxyPort is not supported/);
    expect(warnings.join('\n')).toMatch(/GH has mode mask/);
    expect(warnings.join('\n')).toMatch(/filesystem.disabled is not a boolean/);
    expect(warnings.join('\n')).toMatch(/bwrapPath is not an absolute path/);
  });

  it('makes a layer of a file with only a sandbox section', () => {
    const warnings: string[] = [];
    const read = readPermissionLayer(
      { sandbox: { enabled: true } },
      'user',
      'u.json',
      '/u',
      warnings
    );
    expect(read).toEqual({
      layer: 'user',
      origin: 'u.json',
      anchor: '/u',
      sandbox: { enabled: true },
    });
  });

  it('resolves sandbox paths by their prefix', () => {
    expect(sandboxSettingsPath('/tmp/build', PROJECT, HOME)).toBe('/tmp/build');
    expect(sandboxSettingsPath('//tmp/build', PROJECT, HOME)).toBe('/tmp/build');
    expect(sandboxSettingsPath('~/.kube', PROJECT, HOME)).toBe('/home/dev/.kube');
    expect(sandboxSettingsPath('./output', PROJECT, HOME)).toBe('/work/project/output');
    expect(sandboxSettingsPath('output', PROJECT, HOME)).toBe('/work/project/output');
  });
});

describe('sandboxPolicyOf', () => {
  it('takes a boolean from the highest layer and defaults the rest', () => {
    const { policy } = policyOf([
      layer('user', { enabled: false, autoAllowBashIfSandboxed: false }),
      layer('project', { enabled: true }),
    ]);
    expect(policy).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllow: false,
      allowUnsandboxed: false,
    });
    expect(policyOf([]).policy.enabled).toBe(false);
  });

  it('merges lists across layers, resolving each against its own anchor', () => {
    const { policy } = policyOf([
      layer('user', { filesystem: { allowWrite: ['~/.kube'], denyRead: ['~/.aws'] } }),
      layer('project', {
        excludedCommands: ['docker *'],
        filesystem: { allowWrite: ['./build'], allowRead: ['.'] },
        network: { allowedDomains: ['github.com'], deniedDomains: ['evil.com'] },
      }),
      layer('local', { excludedCommands: ['make *'] }),
    ]);
    expect(policy.excludedCommands).toEqual(['make *', 'docker *']);
    expect(policy.filesystem?.allowWrite).toEqual(['/work/project/build', '/home/dev/.kube']);
    expect(policy.filesystem?.denyRead).toEqual(['/home/dev/.aws']);
    expect(policy.filesystem?.allowRead).toEqual(['/work/project']);
    expect(policy.network?.allowedDomains).toEqual(['github.com']);
    expect(policy.network?.deniedDomains).toEqual(['evil.com']);
  });

  it('adds the paths and domains of Edit, Read and WebFetch rules', () => {
    const { policy } = policyOf([
      layer(
        'project',
        {},
        {
          allow: ['Edit(./generated/**)', 'Edit(src/*.ts)', 'WebFetch(domain:npmjs.org)'],
          deny: ['Read(.env)', 'Edit(//etc/**)', 'WebFetch(domain:*.evil.com)'],
        }
      ),
    ]);
    expect(policy.filesystem?.allowWrite).toEqual(['/work/project/generated']);
    expect(policy.filesystem?.denyRead).toEqual(['/work/project/**/.env']);
    expect(policy.filesystem?.denyWrite).toEqual(['/etc/**']);
    expect(policy.network?.allowedDomains).toEqual(['npmjs.org', '*.npmjs.org']);
    expect(policy.network?.deniedDomains).toEqual(['*.evil.com']);
  });

  it('keeps a false allowUnsandboxedCommands of user settings against a project true', () => {
    expect(
      policyOf([
        layer('user', { allowUnsandboxedCommands: false }),
        layer('project', { allowUnsandboxedCommands: true }),
      ]).policy.allowUnsandboxed
    ).toBe(false);
    expect(
      policyOf([layer('project', { allowUnsandboxedCommands: true })]).policy.allowUnsandboxed
    ).toBe(true);
  });

  it('ignores what a repository loosens once the sandbox is admin-required', () => {
    const { policy } = policyOf([
      layer('managed', {
        enabled: true,
        allowUnsandboxedCommands: false,
        excludedCommands: ['npm *'],
      }),
      layer('user', { enabled: true, excludedCommands: ['docker *'] }),
      layer('project', {
        enabled: false,
        excludedCommands: ['curl *'],
        filesystem: { allowWrite: ['/opt'], denyWrite: ['./locked'] },
        network: { allowedDomains: ['repo.example'], allowLocalBinding: true },
        ignoreViolations: { '*': ['/etc'] },
      }),
    ]);
    expect(policy.enabled).toBe(true);
    expect(policy.excludedCommands).toEqual(['npm *', 'docker *']);
    expect(policy.filesystem?.allowWrite).toEqual([]);
    expect(policy.filesystem?.denyWrite).toEqual(['/work/project/locked']);
    expect(policy.network?.allowedDomains).toEqual([]);
    expect(policy.network?.allowLocalBinding).toBeUndefined();
    expect(policy.ignoreViolations).toBeUndefined();
  });

  it('honors only managed domains under allowManagedDomainsOnly, and refuses unknown hosts', () => {
    const { policy } = policyOf([
      layer('managed', {
        network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] },
      }),
      layer('user', {
        network: { allowedDomains: ['github.com'], deniedDomains: ['bad.example'] },
      }),
    ]);
    expect(policy.network).toMatchObject({
      allowedDomains: ['corp.example'],
      deniedDomains: ['bad.example'],
      strictAllowlist: true,
    });
  });

  it('honors only managed allowRead under allowManagedReadPathsOnly', () => {
    const { policy } = policyOf([
      layer('managed', {
        filesystem: { denyRead: ['~/'], allowRead: ['~/work'], allowManagedReadPathsOnly: true },
      }),
      layer('user', { filesystem: { allowRead: ['~/secrets'] } }),
    ]);
    expect(policy.filesystem?.allowRead).toEqual(['/home/dev/work']);
  });

  it('reads strictAllowlist and filesystem.disabled only from trusted files', () => {
    const repo = policyOf([
      layer('project', { network: { strictAllowlist: true }, filesystem: { disabled: true } }),
    ]);
    expect(repo.policy.network?.strictAllowlist).toBe(false);
    expect(repo.policy.filesystem?.disabled).toBeUndefined();
    expect(repo.warnings.join('\n')).toMatch(/strictAllowlist counts only/);
    const user = policyOf([
      layer('user', { network: { strictAllowlist: true }, filesystem: { disabled: true } }),
      layer('project', { network: { allowedDomains: ['repo.example'] } }),
    ]);
    expect(user.policy.network?.strictAllowlist).toBe(true);
    expect(user.policy.network?.allowedDomains).toEqual([]);
    expect(user.policy.filesystem?.disabled).toBe(true);
    const managed = policyOf([
      layer('managed', { filesystem: { denyRead: ['~/.ssh'] } }),
      layer('user', { filesystem: { disabled: true } }),
    ]);
    expect(managed.policy.filesystem?.disabled).toBeUndefined();
  });

  it('drops a repository allowRead or allowWrite under a trusted denyRead', () => {
    const { policy } = policyOf([
      layer('user', { filesystem: { denyRead: ['~/.ssh'] } }),
      layer('project', { filesystem: { allowRead: ['~/.ssh/keys'], allowWrite: ['~/.ssh'] } }),
    ]);
    expect(policy.filesystem?.allowRead).toEqual([]);
    expect(policy.filesystem?.allowWrite).toEqual([]);
  });

  it('takes bwrapPath and socatPath from managed settings only, and credential files as denyRead', () => {
    const { policy, warnings } = policyOf([
      layer('managed', { bwrapPath: '/opt/bwrap' }),
      layer('user', {
        socatPath: '/opt/socat',
        credentials: {
          files: [{ path: '~/.aws/credentials', mode: 'deny' }],
          envVars: [{ name: 'NPM_TOKEN', mode: 'deny' }],
        },
      }),
    ]);
    expect(policy.bwrapPath).toBe('/opt/bwrap');
    expect(policy.socatPath).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/socatPath counts only from managed/);
    expect(policy.filesystem?.denyRead).toEqual(['/home/dev/.aws/credentials']);
    expect(policy.credentials?.envVars).toEqual(['NPM_TOKEN']);
  });
});

describe('loadSandboxPolicy', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-settings-')));
    mkdirSync(join(dir, 'project', '.claude'), { recursive: true });
    mkdirSync(join(dir, 'user'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads Claude Code's .claude/settings.json as it is", async () => {
    writeFileSync(
      join(dir, 'project', '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { deny: ['Read(./secrets/**)'] },
        sandbox: {
          enabled: true,
          excludedCommands: ['docker *'],
          filesystem: { allowWrite: ['./out'] },
          network: { allowedDomains: ['github.com', '*.npmjs.org'] },
        },
      })
    );
    writeFileSync(
      join(dir, 'user', 'settings.json'),
      JSON.stringify({ sandbox: { network: { deniedDomains: ['evil.com'] } } })
    );
    const { policy, warnings } = await loadSandboxPolicy(join(dir, 'project'), {
      userDirs: [join(dir, 'user')],
      managedDirs: [],
    });
    expect(warnings).toEqual([]);
    expect(policy).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      excludedCommands: ['docker *'],
      filesystem: {
        allowWrite: [join(dir, 'project', 'out')],
        denyRead: [join(dir, 'project', 'secrets', '**')],
      },
      network: { allowedDomains: ['github.com', '*.npmjs.org'], deniedDomains: ['evil.com'] },
    });
  });

  it('keeps only what tightens the sandbox from an untrusted project', async () => {
    writeFileSync(
      join(dir, 'project', '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: true,
          excludedCommands: ['curl *'],
          filesystem: { allowWrite: ['/'], denyWrite: ['./locked'] },
          network: { allowedDomains: ['*'], deniedDomains: ['evil.com'] },
        },
      })
    );
    const { policy } = await loadSandboxPolicy(join(dir, 'project'), {
      userDirs: [join(dir, 'user')],
      managedDirs: [],
      trusted: false,
    });
    expect(policy).toMatchObject({
      enabled: true,
      allowUnsandboxed: false,
      excludedCommands: [],
      filesystem: { allowWrite: [], denyWrite: [join(dir, 'project', 'locked')] },
      network: { allowedDomains: [], deniedDomains: ['evil.com'] },
    });
  });
});
