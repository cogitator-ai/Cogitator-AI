import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_memorySecretStore, experimental_PluginInstaller } from '@cogitator-ai/core';
import { createProgram } from '../program.js';
import {
  parseOptionPairs,
  runInstall,
  runList,
  runMarketplace,
  runSetEnabled,
  runUninstall,
  runValidate,
  type PluginCommandContext,
} from '../commands/plugin.js';

let base: string;
let printed: string[];
let logged: string[];

function context(answers: { confirm?: boolean; secret?: string } = {}): PluginCommandContext {
  const secrets = experimental_memorySecretStore();
  return {
    cwd: join(base, 'project'),
    userDirs: [join(base, 'home')],
    io: {
      print: (line) => printed.push(line),
      confirm: async () => answers.confirm,
      secret: async () => answers.secret,
    },
    installer: (options) =>
      new experimental_PluginInstaller({ ...options, root: join(base, 'plugins'), secrets }),
  };
}

function marketplace(): string {
  const root = join(base, 'market');
  const plugin = join(root, 'plugins', 'greeter');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'commands'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'greeter', version: '1.0.0', description: 'Greets' })
  );
  writeFileSync(join(plugin, 'commands', 'hello.md'), 'Say hello.');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'local-tools',
      owner: { name: 'Team' },
      plugins: [{ name: 'greeter', source: './plugins/greeter' }],
    })
  );
  return root;
}

describe('cogitator plugin', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cog-cli-plugin-'));
    mkdirSync(join(base, 'project'), { recursive: true });
    printed = [];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('is mounted with its subcommands', () => {
    const plugin = createProgram().commands.find((command) => command.name() === 'plugin');
    expect(plugin?.commands.map((command) => command.name())).toEqual([
      'install',
      'uninstall',
      'enable',
      'disable',
      'update',
      'list',
      'configure',
      'validate',
      'marketplace',
      'eval',
    ]);
  });

  it('adds a marketplace, installs, lists, disables and uninstalls a plugin', async () => {
    const source = marketplace();
    expect(await runMarketplace('add', source, {}, context())).toBe(0);
    expect(printed.at(-1)).toMatch(/Successfully added marketplace: local-tools/);
    expect(await runInstall('greeter@local-tools', {}, context())).toBe(0);
    expect(printed.at(-1)).toMatch(
      /Successfully installed plugin: greeter@local-tools 1\.0\.0 \(scope: user\)/
    );
    expect(await runList({ json: true }, context())).toBe(0);
    const rows = JSON.parse(logged.at(-1) ?? '[]') as {
      id: string;
      enabled: boolean;
      version: string;
    }[];
    expect(rows).toEqual([
      expect.objectContaining({ id: 'greeter@local-tools', enabled: true, version: '1.0.0' }),
    ]);
    expect(await runSetEnabled('greeter@local-tools', false, {}, context())).toBe(0);
    expect(JSON.parse(readFileSync(join(base, 'home', 'settings.json'), 'utf8'))).toEqual({
      enabledPlugins: { 'greeter@local-tools': false },
    });
    expect(await runUninstall('greeter@local-tools', { json: true }, context())).toBe(0);
    expect(JSON.parse(logged.at(-1) ?? '{}')).toMatchObject({
      command: 'uninstall',
      outcome: 'ok',
      removed: ['greeter@local-tools'],
    });
  });

  it('answers with failed and a failure code in JSON', async () => {
    expect(await runInstall('missing@nowhere', { json: true }, context())).toBe(1);
    expect(JSON.parse(logged.at(-1) ?? '{}')).toMatchObject({
      command: 'install',
      outcome: 'failed',
      failureCode: 'PLUGIN_NOT_FOUND',
    });
  });

  it('refuses a secret it cannot read from a terminal', async () => {
    const source = marketplace();
    await runMarketplace('add', source, {}, context());
    expect(
      await runInstall('greeter@local-tools', { secret: ['token'], json: true }, context())
    ).toBe(1);
    expect(JSON.parse(logged.at(-1) ?? '{}').message).toMatch(/read from the terminal/);
  });

  it('validates a plugin folder with the exit codes of claude plugin validate', async () => {
    const dir = join(base, 'plugin');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'ok-plugin',
        version: '1.0.0',
        description: 'd',
        author: { name: 'a' },
      })
    );
    expect(await runValidate(dir, {}, context())).toBe(0);
    expect(printed.at(-1)).toMatch(/Validation passed/);
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ok-plugin', unknown: 1 })
    );
    expect(await runValidate(dir, {}, context())).toBe(0);
    expect(await runValidate(dir, { strict: true }, context())).toBe(1);
    expect(printed.at(-1)).toMatch(/--strict treats warnings as errors/);
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'bad name' }));
    expect(await runValidate(dir, { json: true }, context())).toBe(1);
    expect(JSON.parse(logged.at(-1) ?? '{}')).toMatchObject({ success: false });
  });

  it('reads --config pairs as option values', () => {
    expect(parseOptionPairs(['a=1', 'b=true', 'c=text', 'd='])).toEqual({
      a: 1,
      b: true,
      c: 'text',
      d: '',
    });
    expect(() => parseOptionPairs(['novalue'])).toThrow(/key=value/);
  });
});
