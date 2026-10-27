import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  experimental_validatePlugin,
  readPluginLayout,
  pluginNameProblem,
} from '../plugins/manifest';
import { satisfies, maxSatisfying, isValidRange } from '../plugins/semver';
import { PluginFolderSkills } from '../plugins/skills';
import {
  substitute,
  pluginEnvironment,
  substituteServer,
  type PluginVariables,
} from '../plugins/variables';

const FIXTURES = join(__dirname, 'fixtures', 'plugins');

describe('plugin manifests', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cog-manifest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  it('validates the Claude Code fixture as claude plugin validate does', async () => {
    const result = await experimental_validatePlugin(join(FIXTURES, 'deploy-tools'));
    expect(result.ok).toBe(true);
    expect(result.format).toBe('claude');
    expect(result.manifest).toMatchObject({
      name: 'deploy-tools',
      version: '1.2.0',
      displayName: 'Deploy Tools',
    });
    expect(result.errors).toEqual([]);
    const strict = await experimental_validatePlugin(join(FIXTURES, 'deploy-tools'), {
      strict: true,
    });
    expect(strict.ok).toBe(strict.warnings.length === 0);
  });

  it('finds every component in the standard layout, with names as Claude Code gives them', async () => {
    const layout = await readPluginLayout(join(FIXTURES, 'deploy-tools'));
    expect(layout.commandFiles.map((file) => file.name).sort()).toEqual(['db:migrate', 'status']);
    expect(layout.agentFiles.map((file) => file.name).sort()).toEqual(['notes', 'review:security']);
    expect(layout.skillDirs).toHaveLength(1);
    expect(layout.hooks).toHaveLength(1);
    expect(Object.keys(layout.mcpServers)).toEqual(['deploy-api']);
    expect(layout.fatal).toEqual([]);
  });

  it('loads a folder without a manifest, named after the folder', async () => {
    write('commands/hi.md', 'Hi.');
    const layout = await readPluginLayout(dir, { fallbackName: 'bare' });
    expect(layout.manifest.name).toBe('bare');
    expect(layout.commandFiles.map((file) => file.name)).toEqual(['hi']);
  });

  it('strips an unknown top-level field with a warning and fails on an unknown userConfig key', async () => {
    write(
      '.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'x',
        colour: 'blue',
        userConfig: { a: { type: 'string', title: 'A', description: 'a', secret: true } },
      })
    );
    const result = await experimental_validatePlugin(dir);
    expect(result.warnings.map((entry) => entry.message)).toContain(
      "Unknown field 'colour', it is stripped"
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/userConfig/);
    const layout = await readPluginLayout(dir);
    expect(layout.fatal.length).toBeGreaterThan(0);
  });

  it('checks component paths: ./ prefix, existence, containment and links', async () => {
    write('outside/agent.md', '---\nname: a\ndescription: d\n---\nx');
    mkdirSync(join(dir, 'plugin'));
    symlinkSync(join(dir, 'outside'), join(dir, 'plugin', 'linked'));
    writeFileSync(join(dir, 'plugin', 'real.md'), 'r');
    mkdirSync(join(dir, 'plugin', '.claude-plugin'));
    writeFileSync(
      join(dir, 'plugin', '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'paths',
        commands: [
          'commands/foo.md',
          './missing.md',
          './linked/agent.md',
          './real.md',
          './../outside/agent.md',
        ],
      })
    );
    const layout = await readPluginLayout(join(dir, 'plugin'));
    expect(layout.diagnostics.map((entry) => entry.message)).toEqual([
      'commands path must start with "./": commands/foo.md',
      'commands path not found: ./missing.md',
      'commands path escapes plugin directory: ./linked/agent.md',
      'Path contains ".." which could be a path traversal attempt: ./../outside/agent.md',
    ]);
    expect(layout.commandFiles.map((file) => file.name)).toEqual(['real']);
  });

  it('lets the manifest replace the default command and agent folders, warning about the folder left out', async () => {
    write(
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'replace', commands: './extra/', agents: ['./custom/one.md'] })
    );
    write('commands/default.md', 'Default.');
    write('extra/chosen.md', 'Chosen.');
    write('agents/skipped.md', '---\nname: skipped\ndescription: s\n---\n');
    write('custom/one.md', '---\nname: one\ndescription: o\n---\n');
    const layout = await readPluginLayout(dir);
    expect(layout.commandFiles.map((file) => file.name)).toEqual(['chosen']);
    expect(layout.agentFiles.map((file) => file.name)).toEqual(['one']);
    expect(layout.diagnostics.map((entry) => entry.message)).toEqual([
      'Default commands/ folder is ignored because the manifest sets "commands"',
      'Default agents/ folder is ignored because the manifest sets "agents"',
    ]);
  });

  it('reads inline commands, hook files that need their wrapper, and .mcp.json with or without it', async () => {
    write(
      '.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'inline',
        commands: {
          about: { content: 'About it.', description: 'About' },
          both: { content: 'x', source: './x.md' },
        },
        hooks: ['./more-hooks.json', { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] }],
        mcpServers: [{ second: { url: 'https://mcp.example.com/' } }, './server.mcpb'],
      })
    );
    write('more-hooks.json', JSON.stringify({ PreToolUse: [] }));
    write('.mcp.json', JSON.stringify({ first: { command: 'node', args: ['s.js'] } }));
    const layout = await readPluginLayout(dir);
    expect(layout.inlineCommands.map((command) => command.name)).toEqual(['about']);
    expect(layout.hooks.map((source) => source.source)).toEqual([
      join('.claude-plugin', 'plugin.json'),
    ]);
    expect(Object.keys(layout.mcpServers)).toEqual(['first', 'second']);
    const messages = layout.diagnostics.map((entry) => entry.message);
    expect(messages).toContain('commands.both must set exactly one of source and content');
    expect(messages).toContain(
      'Failed to load hooks: the file must hold its events under a top-level "hooks" key'
    );
    expect(messages.some((text) => text.includes('MCP bundles'))).toBe(true);
  });

  it('merges a marketplace entry into the manifest by strict mode', async () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'entry', version: '1.0.0' }));
    write('commands/own.md', 'Own.');
    write('extra/more.md', 'More.');
    const strict = await readPluginLayout(dir, {
      entry: {
        name: 'entry',
        source: './',
        commands: ['./extra/more.md'],
        description: 'From the entry',
        version: '9.9.9',
      },
    });
    expect(strict.commandFiles.map((file) => file.name).sort()).toEqual(['more', 'own']);
    expect(strict.manifest).toMatchObject({ description: 'From the entry', version: '1.0.0' });
    const loose = await readPluginLayout(dir, {
      entry: { name: 'entry', source: './', strict: false, commands: ['./extra/more.md'] },
    });
    expect(loose.fatal).toEqual([
      'Plugin entry has conflicting manifests: both plugin.json and marketplace entry specify components',
    ]);
  });

  it('keeps the default agents and commands folders when a strict entry adds its own', async () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'kit' }));
    write('agents/rev.md', '---\nname: rev\ndescription: Reviews\n---\nReview.');
    write('extra/extra.md', '---\nname: extra\ndescription: Extra\n---\nExtra.');
    write('more/cmd.md', 'More.');
    const layout = await readPluginLayout(dir, {
      entry: {
        name: 'kit',
        source: './',
        agents: ['./extra/extra.md'],
        commands: ['./more/cmd.md'],
      },
    });
    expect(layout.agentFiles.map((file) => file.name).sort()).toEqual(['extra', 'rev']);
    expect(layout.commandFiles.map((file) => file.name)).toEqual(['cmd']);
    expect(layout.diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(layout.fatal).toEqual([]);
  });

  it("replaces the manifest's hooks of an event with a strict entry's", async () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'hooked' }));
    write(
      'hooks/hooks.json',
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo manifest-stop' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo manifest-start' }] }],
        },
      })
    );
    const layout = await readPluginLayout(dir, {
      entry: {
        name: 'hooked',
        source: './',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo entry-stop' }] }] },
      },
    });
    const commands = layout.hooks.flatMap((source) =>
      Object.entries(source.hooks).flatMap(([event, groups]) =>
        (groups ?? []).flatMap((group) =>
          group.hooks.map(
            (handler) => `${event} ${handler.type === 'command' ? handler.command : ''}`
          )
        )
      )
    );
    expect(commands.sort()).toEqual(['SessionStart echo manifest-start', 'Stop echo entry-stop']);
  });

  it('loads only the skills a root-source entry lists, not the whole skills folder', async () => {
    write('skills/xlsx/SKILL.md', '---\nname: xlsx\ndescription: Sheets\n---\nSheets.');
    write('skills/docx/SKILL.md', '---\nname: docx\ndescription: Docs\n---\nDocs.');
    write('skills/art/SKILL.md', '---\nname: art\ndescription: Art\n---\nArt.');
    const layout = await readPluginLayout(dir, {
      entry: {
        name: 'document-skills',
        source: './',
        strict: false,
        skills: ['./skills/xlsx', './skills/docx'],
      },
    });
    expect(layout.skillDirs.map((path) => path.split(/[\\/]/).pop()).sort()).toEqual([
      'docx',
      'xlsx',
    ]);
  });

  it('names a skill at the plugin root after its frontmatter, else after the plugin', async () => {
    const named = join(dir, 'named');
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, 'SKILL.md'), '---\nname: pdf-tools\ndescription: PDFs\n---\nPDFs.');
    const bare = join(dir, 'bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'SKILL.md'), '---\nname: bare\ndescription: Bare\n---\nBare.');
    const variables = { options: {}, secrets: {} };
    const first = await new PluginFolderSkills('kit', [named], variables, true).discover();
    const second = await new PluginFolderSkills('solo', [bare], variables, true).discover();
    expect(first.skills.map((skill) => skill.name)).toEqual(['kit:pdf-tools']);
    expect(second.skills.map((skill) => skill.name)).toEqual(['solo:solo']);
  });

  it('ignores a dependency with an invalid range instead of failing the plugin', async () => {
    write(
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'loose', dependencies: [{ name: 'lib', version: 'not a range' }] })
    );
    const layout = await readPluginLayout(dir);
    expect(layout.fatal).toEqual([]);
    expect(layout.manifest.dependencies).toEqual([]);
    expect(layout.diagnostics.map((entry) => entry.message)).toContain(
      'dependencies: "not a range" of lib is not a semver range, the dependency is ignored'
    );
  });

  it('extends a Claude Code manifest with the Cogitator one', async () => {
    write(
      '.claude-plugin/plugin.json',
      JSON.stringify({ name: 'ext', version: '1.0.0', main: './ignored.js' })
    );
    write(
      '.cogitator-plugin/plugin.json',
      JSON.stringify({
        main: './main.mjs',
        permissions: { allow: ['Read(./x)'] },
        engines: { cogitator: '>=0.70' },
        version: '1.1.0',
      })
    );
    write('main.mjs', 'export default {};');
    const layout = await readPluginLayout(dir);
    expect(layout.format).toBe('cogitator');
    expect(layout.manifest).toMatchObject({
      name: 'ext',
      version: '1.1.0',
      permissions: { allow: ['Read(./x)'] },
      engines: { cogitator: '>=0.70' },
    });
    expect(layout.main).toMatch(/main\.mjs$/);
    expect(layout.diagnostics.map((entry) => entry.message)).toContain(
      `main belongs in ${join('.cogitator-plugin', 'plugin.json')}, it is ignored here`
    );
  });

  it('refuses plugin names Claude Code refuses', () => {
    expect(pluginNameProblem('deploy-tools')).toBeUndefined();
    expect(pluginNameProblem('two words')).toMatch(/spaces/);
    expect(pluginNameProblem('a@b')).toMatch(/"@"/);
    expect(pluginNameProblem('a:b')).toMatch(/":"/);
    expect(pluginNameProblem('a/b')).toMatch(/path separator/);
    expect(pluginNameProblem('a‮b')).toMatch(/bidirectional/);
  });
});

describe('plugin semver', () => {
  it('reads npm ranges', () => {
    expect(satisfies('2.1.5', '~2.1.0')).toBe(true);
    expect(satisfies('2.2.0', '~2.1.0')).toBe(false);
    expect(satisfies('2.9.0', '^2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('1.5.0', '1.2 - 1.6')).toBe(true);
    expect(satisfies('1.2.3', '>= 1.2 < 2')).toBe(true);
    expect(satisfies('2.0.0', '1.x || 2.x')).toBe(true);
    expect(satisfies('2.0.0-beta.1', '^2.0.0')).toBe(false);
    expect(satisfies('2.0.0-beta.1', '^2.0.0-0')).toBe(true);
    expect(maxSatisfying(['2.1.0', '2.1.4', '2.2.0'], '~2.1.0')).toBe('2.1.4');
    expect(isValidRange('not a range')).toBe(false);
  });
});

describe('plugin variables', () => {
  const variables: PluginVariables = {
    root: '/plugins/deploy',
    data: '/data/deploy',
    options: { endpoint: 'https://x', tags: ['a', 'b'] },
    secrets: { token: 's3cret' },
  };

  it('puts paths and options in, secrets only where they are needed', () => {
    expect(
      substitute(
        '${CLAUDE_PLUGIN_ROOT}/x ${COGITATOR_PLUGIN_DATA} ${user_config.endpoint} ${user_config.tags}',
        variables,
        'placeholder'
      )
    ).toBe('/plugins/deploy/x /data/deploy https://x a,b');
    expect(substitute('${user_config.token}', variables, 'placeholder')).toBe(
      '[sensitive option token]'
    );
    expect(substitute('${user_config.token}', variables, 'value')).toBe('s3cret');
    expect(() => substitute('${user_config.token}', variables, 'refuse')).toThrow(/cannot take/);
    expect(substitute('${user_config.unset} ${OTHER}', variables, 'value')).toBe(
      '${user_config.unset} ${OTHER}'
    );
  });

  it('gives hooks the option variables and MCP servers their paths', () => {
    expect(pluginEnvironment(variables, true)).toMatchObject({
      CLAUDE_PLUGIN_ROOT: '/plugins/deploy',
      CLAUDE_PLUGIN_DATA: '/data/deploy',
      CLAUDE_PLUGIN_OPTION_ENDPOINT: 'https://x',
      CLAUDE_PLUGIN_OPTION_TOKEN: 's3cret',
    });
    expect(
      substituteServer(
        {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/s.js'],
          env: { T: '${user_config.token}' },
        },
        variables
      )
    ).toEqual({
      command: 'node',
      args: ['/plugins/deploy/s.js'],
      env: {
        CLAUDE_PLUGIN_ROOT: '/plugins/deploy',
        COGITATOR_PLUGIN_ROOT: '/plugins/deploy',
        CLAUDE_PLUGIN_DATA: '/data/deploy',
        COGITATOR_PLUGIN_DATA: '/data/deploy',
        T: 's3cret',
      },
    });
    expect(
      substituteServer(
        { url: 'https://h/${user_config.endpoint}', headers: { A: '${user_config.token}' } },
        variables
      )
    ).toEqual({
      url: 'https://h/https://x',
      headers: { A: 's3cret' },
    });
  });
});
