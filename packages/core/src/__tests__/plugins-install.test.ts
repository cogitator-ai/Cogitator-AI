import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@cogitator-ai/types';
import {
  experimental_PluginInstaller,
  type PluginInstallQuestion,
} from '../plugins/install/installer';
import { experimental_PluginHost } from '../plugins/host';
import { experimental_memorySecretStore } from '../plugins/secrets';
import { checkGitUrl, marketplaceSourceOf, parseMarketplace } from '../plugins/install/marketplace';
import { npmNameProblem } from '../plugins/install/sources';
import { npmInvocation, runTool } from '../plugins/install/run';
import { pluginDataDir, readInstalledPlugins } from '../plugins/store';
import { download, isLoopbackHost, isPrivateHost } from '../plugins/install/fetch';

const FIXTURES = join(__dirname, 'fixtures', 'plugins');

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  ).trim();

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'initial');
  return git(dir, 'rev-parse', 'HEAD');
}

function plugin(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  writeJson(join(dir, '.claude-plugin', 'plugin.json'), {
    name,
    description: `The ${name} plugin`,
    ...extra,
  });
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'hello.md'), `Say hello from ${name}.\n`);
}

/** A registry that serves packages from memory, as npm's registry API does */
function registry(): {
  server: Server;
  url: () => string;
  publish: (dir: string, name: string, version: string) => void;
} {
  const packages = new Map<
    string,
    { versions: Record<string, unknown>; tarballs: Map<string, Buffer> }
  >();
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/').slice(1);
    for (const [name, entry] of packages) {
      if (path === name) {
        const versions = Object.keys(entry.versions);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            name,
            'dist-tags': { latest: versions.at(-1) },
            versions: entry.versions,
          })
        );
        return;
      }
      const tarball = entry.tarballs.get(path);
      if (tarball) {
        response.setHeader('content-type', 'application/octet-stream');
        response.end(tarball);
        return;
      }
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    url,
    publish(dir, name, version) {
      const stage = mkdtempSync(join(tmpdir(), 'cog-pack-'));
      cpSync(dir, join(stage, 'package'), { recursive: true });
      writeJson(join(stage, 'package', 'package.json'), { name, version });
      const file = join(stage, 'package.tgz');
      execFileSync('tar', ['-czf', file, '-C', stage, 'package']);
      const bytes = readFileSync(file);
      rmSync(stage, { recursive: true, force: true });
      const entry = packages.get(name) ?? { versions: {}, tarballs: new Map<string, Buffer>() };
      const tarballPath = `${name}/-/${name.split('/').pop()}-${version}.tgz`;
      entry.tarballs.set(tarballPath, bytes);
      entry.versions[version] = {
        name,
        version,
        dist: {
          tarball: `${url()}/${tarballPath}`,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
        },
      };
      packages.set(name, entry);
    },
  };
}

describe('plugin installer', () => {
  let base: string;
  let root: string;
  let home: string;
  let project: string;
  let questions: PluginInstallQuestion[];
  const secrets = experimental_memorySecretStore();
  const npm = registry();

  beforeAll(async () => {
    await new Promise<void>((resolve) => npm.server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => npm.server.close(() => resolve()));
  });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cog-install-'));
    root = join(base, 'plugins');
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    questions = [];
    vi.stubEnv('npm_config_cache', join(base, 'npm-cache'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  const installer = (answer = true) =>
    new experimental_PluginInstaller({
      root,
      projectRoot: project,
      userDirs: [home],
      secrets,
      confirm: async (question) => {
        questions.push(question);
        return answer;
      },
    });

  const settings = () =>
    JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;

  it('installs from a git marketplace with a relative source and pins the marketplace commit', async () => {
    const repo = join(base, 'market');
    plugin(join(repo, 'plugins', 'greeter'), 'greeter', { version: '1.0.0' });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'team-tools',
      owner: { name: 'Team' },
      plugins: [{ name: 'greeter', source: './plugins/greeter', description: 'Greets' }],
    });
    const commit = gitRepo(repo);
    const tools = installer();
    const added = await tools.addMarketplace(`file://${repo}`);
    expect(added.marketplace).toMatchObject({ name: 'team-tools', commit });
    const result = await tools.install('greeter@team-tools');
    expect(result).toMatchObject({
      id: 'greeter@team-tools',
      version: '1.0.0',
      alreadyInstalled: false,
    });
    expect(result.installPath).toBe(join(root, 'cache', 'team-tools', 'greeter', '1.0.0'));
    expect(existsSync(join(result.installPath, 'commands', 'hello.md'))).toBe(true);
    expect(existsSync(join(result.installPath, '.git'))).toBe(false);
    expect(settings()).toMatchObject({ enabledPlugins: { 'greeter@team-tools': true } });
    const host = new experimental_PluginHost({
      root: project,
      settings: { userDirs: [home], layers: ['user'] },
      config: { installed: { root } },
    });
    await host.load();
    expect((await readInstalledPlugins(root)).records[0]?.pin).toEqual({ commit });
    expect(host.get('greeter@team-tools')).toMatchObject({ status: 'active', origin: 'installed' });
    expect(host.snapshot().commands.map((command) => command.name)).toEqual(['greeter:hello']);
    await host.dispose();
  });

  it('installs straight from a git repository at a pinned commit and keeps it on update until asked', async () => {
    const repo = join(base, 'direct');
    plugin(repo, 'direct-tool');
    const first = gitRepo(repo);
    writeFileSync(join(repo, 'commands', 'hello.md'), 'A newer hello.\n');
    git(repo, 'commit', '--quiet', '-am', 'second');
    const second = git(repo, 'rev-parse', 'HEAD');
    const tools = installer();
    const result = await tools.install(`git+file://${repo}#${first}`);
    expect(result).toMatchObject({ id: 'direct-tool@git', version: first.slice(0, 12) });
    const [record] = (await readInstalledPlugins(root)).records;
    expect(record?.pin).toEqual({ commit: first });
    expect(record?.source).toMatchObject({ source: 'url', sha: first });
    expect(readFileSync(join(result.installPath, 'commands', 'hello.md'), 'utf8')).toBe(
      'Say hello from direct-tool.\n'
    );
    const same = await tools.update('direct-tool@git');
    expect(same[0]).toMatchObject({ updated: false, from: first.slice(0, 12) });
    expect(second).not.toBe(first);
  });

  it('installs from an npm registry with a pinned version and integrity, without install scripts', async () => {
    const source = join(base, 'npm-plugin');
    plugin(source, 'npm-tool', { version: '1.4.0' });
    npm.publish(source, 'npm-tool', '1.4.0');
    npm.publish(source, 'npm-tool', '1.5.0');
    const repo = join(base, 'npm-market');
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'npm-market',
      owner: { name: 'Team' },
      plugins: [
        {
          name: 'npm-tool',
          source: { source: 'npm', package: 'npm-tool', version: '~1.4.0', registry: npm.url() },
        },
      ],
    });
    const tools = installer();
    await tools.addMarketplace(repo);
    const result = await tools.install('npm-tool@npm-market');
    expect(result.version).toBe('1.4.0');
    const [record] = (await readInstalledPlugins(root)).records;
    expect(record?.pin.npmVersion).toBe('1.4.0');
    expect(record?.pin.integrity).toMatch(/^sha512-/);
    expect(existsSync(join(result.installPath, 'commands', 'hello.md'))).toBe(true);
  });

  it('refuses an npm source that is a git address or a folder', async () => {
    const repo = join(base, 'bad-market');
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'bad-market',
      owner: { name: 'Team' },
      plugins: [
        { name: 'from-git', source: { source: 'npm', package: 'git+https://example.com/x.git' } },
        { name: 'from-folder', source: { source: 'npm', package: 'file:vendor/x' } },
        { name: 'escaping', source: { source: 'npm', package: '../x' } },
      ],
    });
    const tools = installer();
    await tools.addMarketplace(repo);
    await expect(tools.install('from-git@bad-market')).rejects.toThrow(
      /a git address is not an npm package/
    );
    await expect(tools.install('from-folder@bad-market')).rejects.toThrow(
      /a folder is not an npm package/
    );
    await expect(tools.install('escaping@bad-market')).rejects.toThrow(/has no plugin escaping/);
  });

  it('asks for the permissions a plugin wants, records them, and refuses without consent', async () => {
    const repo = join(base, 'perm-market');
    const dir = join(repo, 'plugins', 'guarded');
    plugin(dir, 'guarded', { version: '1.0.0' });
    writeJson(join(dir, '.cogitator-plugin', 'plugin.json'), {
      permissions: { allow: ['Read(./docs/**)'], deny: ['Read(./docs/secret.md)'] },
    });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'perm-market',
      owner: { name: 'Team' },
      plugins: [{ name: 'guarded', source: './plugins/guarded' }],
    });
    const refused = installer(false);
    await refused.addMarketplace(repo);
    await expect(refused.install('guarded@perm-market')).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_PERMISSION_DENIED,
    });
    expect(questions).toEqual([
      {
        kind: 'permissions',
        plugin: 'guarded@perm-market',
        allow: ['Read(./docs/**)'],
        deny: ['Read(./docs/secret.md)'],
        update: false,
      },
    ]);
    const granted = installer(true);
    await granted.install('guarded@perm-market');
    const [record] = (await readInstalledPlugins(root)).records;
    expect(record?.grantedPermissions).toEqual({
      allow: ['Read(./docs/**)'],
      deny: ['Read(./docs/secret.md)'],
    });
    expect(record?.installPath).toBe(realpathSync(join(repo, 'plugins', 'guarded')));
  });

  it('installs a dependency at the highest tag its range allows', async () => {
    const lib = join(base, 'vault');
    plugin(lib, 'secrets-vault', { version: '2.1.0' });
    gitRepo(lib);
    git(lib, 'tag', 'secrets-vault--v2.1.0');
    writeJson(join(lib, '.claude-plugin', 'plugin.json'), {
      name: 'secrets-vault',
      version: '2.1.3',
    });
    git(lib, 'commit', '--quiet', '-am', 'patch');
    git(lib, 'tag', 'secrets-vault--v2.1.3');
    writeJson(join(lib, '.claude-plugin', 'plugin.json'), {
      name: 'secrets-vault',
      version: '2.2.0',
    });
    git(lib, 'commit', '--quiet', '-am', 'minor');
    git(lib, 'tag', 'secrets-vault--v2.2.0');
    const repo = join(base, 'dep-market');
    plugin(join(repo, 'plugins', 'deploy-kit'), 'deploy-kit', {
      version: '3.1.0',
      dependencies: [{ name: 'secrets-vault', version: '~2.1.0' }],
    });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'dep-market',
      owner: { name: 'Team' },
      plugins: [
        { name: 'deploy-kit', source: './plugins/deploy-kit' },
        { name: 'secrets-vault', source: { source: 'url', url: `file://${lib}` } },
      ],
    });
    const tools = installer();
    await tools.addMarketplace(repo);
    const result = await tools.install('deploy-kit@dep-market');
    expect(
      result.installed.map((record) => [record.id, record.version, record.dependency === true])
    ).toEqual([
      ['deploy-kit@dep-market', '3.1.0', false],
      ['secrets-vault@dep-market', '2.1.3', true],
    ]);
    expect(settings()).toEqual({ enabledPlugins: { 'deploy-kit@dep-market': true } });
    await expect(tools.uninstall('secrets-vault@dep-market')).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
    });
    const removed = await tools.uninstall('deploy-kit@dep-market', { prune: true });
    expect(removed.removed).toEqual(['deploy-kit@dep-market', 'secrets-vault@dep-market']);
    expect((await readInstalledPlugins(root)).records).toEqual([]);
  });

  it('installs an archive over https checked against its sha256 pin', async () => {
    const zip = buildZip({
      'formatter/.claude-plugin/plugin.json': JSON.stringify({
        name: 'formatter',
        version: '2.0.0',
      }),
      'formatter/commands/format.md': 'Format the file.\n',
    });
    const digest = createHash('sha256').update(zip).digest('hex');
    const repo = join(base, 'zip-market');
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'zip-market',
      owner: { name: 'Team' },
      plugins: [
        {
          name: 'formatter',
          source: {
            source: 'archive',
            url: 'https://artifacts.example.com/formatter.zip',
            sha256: digest,
          },
        },
        {
          name: 'tampered',
          source: {
            source: 'archive',
            url: 'https://artifacts.example.com/formatter.zip',
            sha256: '0'.repeat(64),
          },
        },
      ],
    });
    const tools = new experimental_PluginInstaller({
      root,
      projectRoot: project,
      userDirs: [home],
      secrets,
      fetchFn: async () => new Response(new Uint8Array(zip)),
    });
    await tools.addMarketplace(repo);
    const result = await tools.install('formatter@zip-market');
    expect(result.version).toBe('2.0.0');
    expect(readFileSync(join(result.installPath, 'commands', 'format.md'), 'utf8')).toBe(
      'Format the file.\n'
    );
    await expect(tools.install('tampered@zip-market')).rejects.toThrow(
      /does not match its sha256 pin/
    );
  });

  it('saves options to the user settings and secrets to the store, and removes both on uninstall', async () => {
    const repo = join(base, 'opt-market');
    plugin(join(repo, 'p'), 'configured', {
      userConfig: {
        endpoint: { type: 'string', title: 'Endpoint', description: 'Where' },
        token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true },
      },
    });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'opt-market',
      owner: { name: 'T' },
      plugins: [{ name: 'configured', source: './p' }],
    });
    const tools = installer();
    await tools.addMarketplace(repo);
    const result = await tools.install('configured@opt-market', {
      options: { endpoint: 'https://x.example' },
    });
    expect(result.notes).toEqual([
      'userConfig options not yet set: token (cogitator plugin configure configured@opt-market)',
    ]);
    await tools.configure('configured@opt-market', { secrets: { token: 't-1' } });
    expect(settings()).toMatchObject({
      pluginConfigs: { 'configured@opt-market': { options: { endpoint: 'https://x.example' } } },
    });
    expect(await secrets.get('cogitator-plugin:configured@opt-market', 'token')).toBe('t-1');
    await expect(
      tools.configure('configured@opt-market', { options: { token: 'plain' } })
    ).rejects.toThrow(/is sensitive/);
    await tools.uninstall('configured@opt-market');
    expect(await secrets.get('cogitator-plugin:configured@opt-market', 'token')).toBeUndefined();
    expect(settings()).toEqual({});
  });

  const gitMarket = (
    name: string,
    plugins: { name: string; extra?: Record<string, unknown> }[],
    folder = name
  ) => {
    const repo = join(base, folder);
    for (const entry of plugins) plugin(join(repo, 'plugins', entry.name), entry.name, entry.extra);
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name,
      owner: { name: 'Team' },
      plugins: plugins.map((entry) => ({ name: entry.name, source: `./plugins/${entry.name}` })),
    });
    gitRepo(repo);
    return repo;
  };

  it('refuses a version that would put the plugin outside its own folder', async () => {
    const repo = gitMarket('dots', [
      { name: 'good', extra: { version: '1.0.0' } },
      { name: 'evil', extra: { version: '..' } },
    ]);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    const good = await tools.install('good@dots');
    await expect(tools.install('evil@dots')).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_INVALID,
    });
    expect(existsSync(join(good.installPath, 'commands', 'hello.md'))).toBe(true);
    expect((await readInstalledPlugins(root)).records.map((record) => record.id)).toEqual([
      'good@dots',
    ]);
  });

  it('checks options before writing anything, and gives a dependency none of them', async () => {
    const repo = gitMarket('opts', [
      {
        name: 'app',
        extra: {
          version: '1.0.0',
          dependencies: ['lib'],
          userConfig: {
            endpoint: { type: 'string', title: 'Endpoint', description: 'Where' },
            token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true },
          },
        },
      },
      {
        name: 'lib',
        extra: {
          version: '1.0.0',
          userConfig: {
            token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true },
          },
        },
      },
    ]);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await expect(tools.install('app@opts', { options: { nope: 'x' } })).rejects.toThrow(
      /declares no option nope/
    );
    expect((await readInstalledPlugins(root)).records).toEqual([]);
    expect(existsSync(join(home, 'settings.json'))).toBe(false);
    const result = await tools.install('app@opts', {
      options: { endpoint: 'https://x.example' },
      secrets: { token: 'app-token' },
    });
    expect(result.installed.map((record) => record.id)).toEqual(['app@opts', 'lib@opts']);
    expect(await secrets.get('cogitator-plugin:app@opts', 'token')).toBe('app-token');
    expect(await secrets.get('cogitator-plugin:lib@opts', 'token')).toBeUndefined();
    expect(settings()).toMatchObject({
      pluginConfigs: { 'app@opts': { options: { endpoint: 'https://x.example' } } },
    });
  });

  it('configures a plugin named without its marketplace under its full id, refusing an ambiguous name', async () => {
    const options = {
      userConfig: { endpoint: { type: 'string', title: 'Endpoint', description: 'Where' } },
    };
    const first = gitMarket('one', [{ name: 'tool', extra: { version: '1.0.0', ...options } }]);
    const tools = installer();
    await tools.addMarketplace(`file://${first}`);
    await tools.install('tool@one');
    await tools.configure('tool', { options: { endpoint: 'https://one.example' } });
    expect(settings()).toMatchObject({
      pluginConfigs: { 'tool@one': { options: { endpoint: 'https://one.example' } } },
    });
    expect(Object.keys(settings().pluginConfigs as object)).toEqual(['tool@one']);
    const second = gitMarket('two', [{ name: 'tool', extra: { version: '1.0.0', ...options } }]);
    await tools.addMarketplace(`file://${second}`);
    await tools.install('tool@two');
    await expect(tools.configure('tool', { options: { endpoint: 'x' } })).rejects.toThrow(
      /installed from several marketplaces/
    );
  });

  it('keeps the files of an added marketplace when another source has its name', async () => {
    const first = gitMarket('team', [{ name: 'alpha', extra: { version: '1.0.0' } }], 'team-a');
    const second = gitMarket('team', [{ name: 'beta', extra: { version: '1.0.0' } }], 'team-b');
    const tools = installer();
    await tools.addMarketplace(`file://${first}`);
    await expect(tools.addMarketplace(`file://${second}`)).rejects.toThrow(/already added from/);
    const read = await tools.readMarketplace('team');
    expect(read.manifest.plugins.map((entry) => entry.name)).toEqual(['alpha']);
  });

  it('installs the dependencies a new version adds, and keeps a dependency within its range on update', async () => {
    const lib = join(base, 'vault');
    plugin(lib, 'vault', { version: '1.1.0' });
    gitRepo(lib);
    git(lib, 'tag', 'vault--v1.1.0');
    writeJson(join(lib, '.claude-plugin', 'plugin.json'), { name: 'vault', version: '2.0.0' });
    git(lib, 'commit', '--quiet', '-am', 'major');
    git(lib, 'tag', 'vault--v2.0.0');
    const repo = join(base, 'grow');
    plugin(join(repo, 'plugins', 'app'), 'app', { version: '1.0.0' });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'grow',
      owner: { name: 'Team' },
      plugins: [
        { name: 'app', source: './plugins/app' },
        { name: 'vault', source: { source: 'url', url: `file://${lib}` } },
      ],
    });
    gitRepo(repo);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await tools.install('app@grow');
    writeJson(join(repo, 'plugins', 'app', '.claude-plugin', 'plugin.json'), {
      name: 'app',
      version: '2.0.0',
      dependencies: [{ name: 'vault', version: '^1.0.0' }],
    });
    git(repo, 'commit', '--quiet', '-am', 'needs vault');
    const [updated] = await tools.update('app@grow');
    expect(updated).toMatchObject({ updated: true, to: '2.0.0' });
    expect(updated?.notes).toContain('installed the dependency vault@grow');
    const versions = () =>
      readInstalledPlugins(root).then(({ records }) =>
        Object.fromEntries(records.map((record) => [record.id, record.version]))
      );
    expect(await versions()).toEqual({ 'app@grow': '2.0.0', 'vault@grow': '1.1.0' });
    const [vault] = await tools.update('vault@grow');
    expect(vault).toMatchObject({ updated: false, to: '1.1.0' });
    expect(await versions()).toEqual({ 'app@grow': '2.0.0', 'vault@grow': '1.1.0' });
  });

  it('enables and disables in the settings file that decides, and says when another one overrides', async () => {
    const repo = gitMarket('scoped', [{ name: 'tool', extra: { version: '1.0.0' } }]);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await tools.install('tool@scoped');
    writeJson(join(project, '.cogitator', 'settings.json'), {
      enabledPlugins: { 'tool@scoped': true },
    });
    const off = await tools.setEnabled('tool@scoped', false);
    expect(off).toMatchObject({ scope: 'project' });
    expect(off.overriddenBy).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(project, '.cogitator', 'settings.json'), 'utf8'))
    ).toMatchObject({ enabledPlugins: { 'tool@scoped': false } });
    const user = await tools.setEnabled('tool@scoped', true, 'user');
    expect(user).toMatchObject({ scope: 'user', overriddenBy: 'project' });
  });

  it('sends the headers of a download only to its own origin, never after a redirect away', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetchFn = (async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url === 'https://market.example/a') {
        return new Response(null, { status: 302, headers: { location: '/b' } });
      }
      if (url === 'https://market.example/b') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/c' },
        });
      }
      return new Response('body');
    }) as typeof fetch;
    const body = await download('https://market.example/a', 'The file', {
      headers: { Authorization: 'Bearer secret-token' },
      fetchFn,
    });
    expect(body.toString()).toBe('body');
    expect(seen).toEqual([
      { url: 'https://market.example/a', authorization: 'Bearer secret-token' },
      { url: 'https://market.example/b', authorization: 'Bearer secret-token' },
      { url: 'https://cdn.example/c', authorization: null },
    ]);
  });

  it('refuses private addresses however an IPv6 address writes them', async () => {
    const privateHosts = [
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      new URL('https://[::ffff:127.0.0.1]/').hostname,
      new URL('https://[::ffff:169.254.169.254]/').hostname,
      '[::ffff:7f00:1]',
      '[::]',
      '[::1]',
      '[fd00:ec2::254]',
      '[fc00::1]',
      '[fe80::1]',
      '[64:ff9b::a9fe:a9fe]',
      '[2002:7f00:1::]',
      '[ff02::1]',
    ];
    for (const host of privateHosts) expect([host, isPrivateHost(host)]).toEqual([host, true]);
    for (const host of ['1.1.1.1', '[2606:4700::1111]', '[::ffff:8.8.8.8]', 'example.com']) {
      expect([host, isPrivateHost(host)]).toEqual([host, false]);
    }
    expect(isLoopbackHost('[::ffff:7f00:1]')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('[fe80::1]')).toBe(false);
    const fetchFn = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://[::ffff:169.254.169.254]/latest' },
      })) as unknown as typeof fetch;
    await expect(download('https://[::ffff:127.0.0.1]/x', 'The file', { fetchFn })).rejects.toThrow(
      /may not point at a loopback/
    );
    await expect(download('https://market.example/x', 'The file', { fetchFn })).rejects.toThrow(
      /may not point at a loopback/
    );
  });

  it('updates an installed dependency to the range a new plugin needs, or refuses before writing', async () => {
    const lib = join(base, 'lib');
    plugin(lib, 'lib', { version: '1.0.0' });
    gitRepo(lib);
    git(lib, 'tag', 'lib--v1.0.0');
    writeJson(join(lib, '.claude-plugin', 'plugin.json'), { name: 'lib', version: '2.1.0' });
    git(lib, 'commit', '--quiet', '-am', 'two');
    git(lib, 'tag', 'lib--v2.1.0');
    const repo = join(base, 'deps');
    plugin(join(repo, 'plugins', 'old-app'), 'old-app', {
      version: '1.0.0',
      dependencies: [{ name: 'lib', version: '^1.0.0' }],
    });
    plugin(join(repo, 'plugins', 'new-app'), 'new-app', {
      version: '1.0.0',
      dependencies: [{ name: 'lib', version: '^2.0.0' }],
    });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'deps',
      owner: { name: 'Team' },
      plugins: [
        { name: 'old-app', source: './plugins/old-app' },
        { name: 'new-app', source: './plugins/new-app' },
        { name: 'lib', source: { source: 'url', url: `file://${lib}` } },
      ],
    });
    gitRepo(repo);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await tools.install('old-app@deps');
    const versions = () =>
      readInstalledPlugins(root).then(({ records }) =>
        Object.fromEntries(records.map((record) => [record.id, record.version]))
      );
    expect(await versions()).toEqual({ 'old-app@deps': '1.0.0', 'lib@deps': '1.0.0' });
    await expect(tools.install('new-app@deps')).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
    });
    expect(await versions()).toEqual({ 'old-app@deps': '1.0.0', 'lib@deps': '1.0.0' });
    await tools.uninstall('old-app@deps');
    await tools.install('new-app@deps');
    expect(await versions()).toEqual({ 'new-app@deps': '1.0.0', 'lib@deps': '2.1.0' });
  });

  it("takes a dependency installed by hand as the person's own, keeping it on a prune", async () => {
    const repo = gitMarket('own', [
      { name: 'app', extra: { version: '1.0.0', dependencies: ['lib'] } },
      {
        name: 'lib',
        extra: {
          version: '1.0.0',
          userConfig: { level: { type: 'string', title: 'Level', description: 'How much' } },
        },
      },
    ]);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await tools.install('app@own');
    const flag = async () =>
      (await readInstalledPlugins(root)).records.find((record) => record.id === 'lib@own')
        ?.dependency;
    expect(await flag()).toBe(true);
    await expect(tools.install('lib@own', { options: { nope: 'x' } })).rejects.toThrow(
      /declares no option nope/
    );
    const again = await tools.install('lib@own', { options: { level: 'high' } });
    expect(again.alreadyInstalled).toBe(true);
    expect(await flag()).toBeUndefined();
    expect(settings()).toMatchObject({
      enabledPlugins: { 'app@own': true, 'lib@own': true },
      pluginConfigs: { 'lib@own': { options: { level: 'high' } } },
    });
    const removed = await tools.uninstall('app@own', { prune: true });
    expect(removed.removed).toEqual(['app@own']);
    expect((await readInstalledPlugins(root)).records.map((record) => record.id)).toEqual([
      'lib@own',
    ]);
  });

  it('keeps a dependency at its version when an update would leave a range of a plugin that needs it', async () => {
    const repo = gitMarket('ranged', [
      {
        name: 'app',
        extra: { version: '1.0.0', dependencies: [{ name: 'lib', version: '^1.0.0' }] },
      },
      { name: 'lib', extra: { version: '1.0.0' } },
    ]);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await tools.install('app@ranged');
    writeJson(join(repo, 'plugins', 'lib', '.claude-plugin', 'plugin.json'), {
      name: 'lib',
      version: '2.0.0',
    });
    git(repo, 'commit', '--quiet', '-am', 'lib two');
    const [result] = await tools.update('lib@ranged');
    expect(result).toMatchObject({ updated: false, from: '1.0.0', to: '1.0.0' });
    expect(result?.notes).toContain(
      'lib stays at 1.0.0: 2.0.0 does not satisfy ^1.0.0, which app@ranged needs'
    );
    const lib = (await readInstalledPlugins(root)).records.find(
      (record) => record.id === 'lib@ranged'
    );
    expect(lib?.version).toBe('1.0.0');
  });

  it('lets nothing but an npm name and a version or tag reach the npm command line', async () => {
    for (const name of ['foo', '@scope/foo', 'foo.bar_baz-1', 'Legacy~Name']) {
      expect([name, npmNameProblem(name)]).toEqual([name, undefined]);
    }
    for (const name of ['foo & whoami & rem', '.hidden', '_under', '@scope', 'a/b', 'x"y', '']) {
      expect(npmNameProblem(name)).toBeDefined();
    }
    const tools = installer();
    await expect(tools.install('npm:foo&whoami&rem')).rejects.toThrow(/the package name/);
    await expect(tools.install('npm:foo@1.0.0 & whoami')).rejects.toThrow(
      /neither a semver range nor a dist-tag/
    );
    expect(questions).toEqual([]);
  });

  it('starts npm without a shell: npm on POSIX, node with npm-cli.js on Windows', () => {
    const host = (env: NodeJS.ProcessEnv, present: string[]) => ({
      platform: 'win32' as const,
      env,
      execPath: 'C:\\node\\node.exe',
      exists: (path: string) => present.includes(path),
    });
    const bundled = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js';
    expect(
      npmInvocation({ platform: 'linux', env: {}, execPath: '/usr/bin/node', exists: () => false })
    ).toEqual({ file: 'npm', args: [] });
    expect(npmInvocation(host({}, [bundled]))).toEqual({
      file: 'C:\\node\\node.exe',
      args: [bundled],
    });
    expect(
      npmInvocation(
        host({ npm_execpath: 'D:\\npm\\bin\\npm-cli.js' }, ['D:\\npm\\bin\\npm-cli.js'])
      )
    ).toEqual({ file: 'C:\\node\\node.exe', args: ['D:\\npm\\bin\\npm-cli.js'] });
    expect(
      npmInvocation(host({ npm_execpath: 'D:\\pnpm\\pnpm.cjs' }, ['D:\\pnpm\\pnpm.cjs', bundled]))
    ).toEqual({ file: 'C:\\node\\node.exe', args: [bundled] });
    expect(() => npmInvocation(host({}, []))).toThrow(/npm-cli\.js was not found/);
  });

  it.skipIf(process.platform === 'win32')(
    'kills what an install command started when it times out',
    async () => {
      const started = Date.now();
      await expect(
        runTool('/bin/sh', ['-c', 'sleep 3; echo done'], { timeoutMs: 50 })
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(1500);
    }
  );

  it('refuses a git URL that git would read as an option', async () => {
    const tools = installer();
    await expect(tools.install('git+-oProxyCommand=touch@x:y')).rejects.toThrow();
    expect(() => checkGitUrl('-oProxyCommand=touch@x:y')).toThrow(/read as an option of git/);
  });

  it.each(['relative', 'archive', 'npm'] as const)(
    'checks the version a %s dependency would install at against every range on it, before writing',
    async (kind) => {
      const archives = new Map<string, Buffer>();
      const lib = `lib-${kind}`;
      const libEntry = (version: string) => {
        if (kind === 'relative') {
          plugin(join(market, 'plugins', lib), lib, { version });
          return { name: lib, source: `./plugins/${lib}` };
        }
        if (kind === 'archive') {
          const zip = buildZip({
            [`${lib}/.claude-plugin/plugin.json`]: JSON.stringify({ name: lib, version }),
          });
          const url = `https://artifacts.example.com/${lib}-${version}.zip`;
          archives.set(url, zip);
          const sha256 = createHash('sha256').update(zip).digest('hex');
          return { name: lib, source: { source: 'archive', url, sha256 } };
        }
        const dir = join(base, `${lib}-${version}`);
        plugin(dir, lib, { version });
        npm.publish(dir, lib, version);
        return { name: lib, source: { source: 'npm', package: lib, registry: npm.url() } };
      };
      const market = join(base, `market-${kind}`);
      const publish = (version: string) => {
        plugin(join(market, 'plugins', 'wants-two'), 'wants-two', {
          version: '1.0.0',
          dependencies: [{ name: lib, version: '^2.0.0' }],
        });
        plugin(join(market, 'plugins', 'wants-one'), 'wants-one', {
          version: '1.0.0',
          dependencies: [{ name: lib, version: '^1.0.0' }],
        });
        writeJson(join(market, '.claude-plugin', 'marketplace.json'), {
          name: `m-${kind}`,
          owner: { name: 'Team' },
          plugins: [
            { name: 'wants-two', source: './plugins/wants-two' },
            { name: 'wants-one', source: './plugins/wants-one' },
            libEntry(version),
          ],
        });
      };
      publish('1.0.0');
      const tools = new experimental_PluginInstaller({
        root,
        projectRoot: project,
        userDirs: [home],
        secrets,
        confirm: async () => true,
        fetchFn: async (input) => {
          const zip = archives.get(String(input));
          return zip ? new Response(new Uint8Array(zip)) : new Response(null, { status: 404 });
        },
      });
      await tools.addMarketplace(market);
      const ids = async () => (await readInstalledPlugins(root)).records.map((r) => r.id).sort();
      await expect(tools.install(`wants-two@m-${kind}`)).rejects.toThrow();
      expect(await ids()).toEqual([]);
      await tools.install(`wants-one@m-${kind}`);
      expect(await ids()).toEqual([`${lib}@m-${kind}`, `wants-one@m-${kind}`]);
      publish('2.0.0');
      const [updated] = await tools.update(`${lib}@m-${kind}`);
      expect(updated).toMatchObject({ updated: false, to: '1.0.0' });
      const record = (await readInstalledPlugins(root)).records.find((r) => r.name === lib);
      expect(record?.version).toBe('1.0.0');
    }
  );

  it('counts the ranges of the plugins still being installed when it picks a shared dependency', async () => {
    const lib = join(base, 'shared-lib');
    plugin(lib, 'shared', { version: '1.0.0' });
    gitRepo(lib);
    git(lib, 'tag', 'shared--v1.0.0');
    writeJson(join(lib, '.claude-plugin', 'plugin.json'), { name: 'shared', version: '2.0.0' });
    git(lib, 'commit', '--quiet', '-am', 'two');
    git(lib, 'tag', 'shared--v2.0.0');
    const repo = join(base, 'chain');
    plugin(join(repo, 'plugins', 'app'), 'app', {
      version: '1.0.0',
      dependencies: [{ name: 'shared', version: '^1.0.0' }, 'helper'],
    });
    plugin(join(repo, 'plugins', 'helper'), 'helper', {
      version: '1.0.0',
      dependencies: [{ name: 'shared', version: '^2.0.0' }],
    });
    plugin(join(repo, 'plugins', 'tool'), 'tool', {
      version: '1.0.0',
      dependencies: [{ name: 'shared', version: '>=1.0.0' }, 'helper'],
    });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'chain',
      owner: { name: 'Team' },
      plugins: [
        { name: 'app', source: './plugins/app' },
        { name: 'helper', source: './plugins/helper' },
        { name: 'tool', source: './plugins/tool' },
        { name: 'shared', source: { source: 'url', url: `file://${lib}` } },
      ],
    });
    gitRepo(repo);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    await expect(tools.install('app@chain')).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
    });
    expect((await readInstalledPlugins(root)).records).toEqual([]);
    await tools.install('tool@chain');
    const versions = Object.fromEntries(
      (await readInstalledPlugins(root)).records.map((record) => [record.id, record.version])
    );
    expect(versions).toEqual({
      'tool@chain': '1.0.0',
      'helper@chain': '1.0.0',
      'shared@chain': '2.0.0',
    });
  });

  it('gives every plugin id a data folder of its own', () => {
    const folders = ['foo-bar@baz', 'foo@bar-baz', 'Tool@x', 'tool@x'].map((id) =>
      pluginDataDir(root, id).toLowerCase()
    );
    expect(new Set(folders).size).toBe(4);
    expect(pluginDataDir(root, 'foo-bar@baz')).toMatch(/[\\/]data[\\/]foo-bar-baz-[0-9a-f]{16}$/);
  });

  it('reads marketplace sources as claude plugin marketplace add does', () => {
    expect(marketplaceSourceOf('acme/tools')).toEqual({ source: 'github', repo: 'acme/tools' });
    expect(marketplaceSourceOf('acme/tools#v2')).toEqual({
      source: 'github',
      repo: 'acme/tools',
      ref: 'v2',
    });
    expect(marketplaceSourceOf('acme/tools@v2')).toEqual({
      source: 'github',
      repo: 'acme/tools',
      ref: 'v2',
    });
    expect(marketplaceSourceOf('git@gitlab.com:acme/tools.git#main')).toEqual({
      source: 'git',
      url: 'git@gitlab.com:acme/tools.git',
      ref: 'main',
    });
    expect(marketplaceSourceOf('https://example.com/repo.git')).toEqual({
      source: 'git',
      url: 'https://example.com/repo.git',
    });
    expect(marketplaceSourceOf('https://github.com/acme/tools')).toEqual({
      source: 'git',
      url: 'https://github.com/acme/tools.git',
    });
    expect(marketplaceSourceOf('https://example.com/marketplace.json')).toEqual({
      source: 'url',
      url: 'https://example.com/marketplace.json',
    });
    expect(marketplaceSourceOf('./market', '/work')).toEqual({
      source: 'directory',
      path: '/work/market',
    });
    expect(() => marketplaceSourceOf('not a source')).toThrow(/Invalid marketplace source format/);
  });

  it('checks a marketplace file: bad entries are skipped, official names refused', () => {
    const read = parseMarketplace(
      JSON.stringify({
        name: 'mine',
        owner: { name: 'Me' },
        plugins: [
          { name: 'ok', source: './ok' },
          { name: 'no-prefix', source: 'plugins/x' },
          { name: 'escapes', source: './../x' },
          { name: 'ok', source: './again' },
          { name: 'bad name', source: './x' },
        ],
      }),
      'marketplace.json',
      { source: 'directory', path: '/m' }
    );
    expect(read.manifest.plugins.map((entry) => entry.name)).toEqual(['ok']);
    expect(read.diagnostics.map((entry) => entry.message)).toEqual([
      'plugins.1.source: Invalid string: must start with "./"',
      'plugins[2].source: Path contains "..": ./../x',
      'Duplicate plugin name "ok" found in marketplace',
      'plugins[4]: the plugin name "bad name" holds spaces, use kebab-case',
    ]);
    expect(() =>
      parseMarketplace(
        JSON.stringify({ name: 'claude-plugins-official', owner: { name: 'x' }, plugins: [] }),
        'm.json',
        { source: 'github', repo: 'someone/fake' }
      )
    ).toThrow(/impersonates an official Anthropic\/Claude marketplace/);
    expect(() =>
      parseMarketplace(
        JSON.stringify({ name: 'npm', owner: { name: 'x' }, plugins: [] }),
        'm.json',
        { source: 'directory', path: '/m' }
      )
    ).toThrow(/reserved/);
  });

  it('loads a plugin of the Claude Code fixture installed from a local marketplace', async () => {
    const repo = join(base, 'cc-market');
    cpSync(join(FIXTURES, 'deploy-tools'), join(repo, 'plugins', 'deploy-tools'), {
      recursive: true,
    });
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'cc-market',
      owner: { name: 'T' },
      plugins: [{ name: 'deploy-tools', source: './plugins/deploy-tools' }],
    });
    gitRepo(repo);
    const tools = installer();
    await tools.addMarketplace(`file://${repo}`);
    const result = await tools.install('deploy-tools@cc-market');
    expect(result.version).toBe('1.2.0');
    expect((await tools.setEnabled('deploy-tools@cc-market', false)).file).toBe(
      join(home, 'settings.json')
    );
    expect(settings()).toMatchObject({ enabledPlugins: { 'deploy-tools@cc-market': false } });
  });
});

/** A zip archive of `files`, stored without compression */
function buildZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
