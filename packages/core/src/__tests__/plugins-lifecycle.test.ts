import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, type PluginDefinition, type PluginHostEvent } from '@cogitator-ai/types';
import { experimental_PluginHost } from '../plugins/host';
import { experimental_definePlugin } from '../plugins/define';
import { experimental_memorySecretStore } from '../plugins/secrets';
import { writeInstalledPlugins } from '../plugins/store';
import { tool } from '../tool';

const echo = (name: string) =>
  tool({
    name,
    description: `The ${name} tool`,
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => `${name}: ${text}`,
  });

describe('plugin lifecycle', () => {
  let base: string;
  let events: PluginHostEvent[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cog-lifecycle-'));
    events = [];
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const host = (plugins: PluginDefinition[], extra: { dirs?: string[] } = {}) =>
    new experimental_PluginHost({
      root: base,
      config: {
        plugins,
        installed: { root: join(base, '.plugins') },
        secrets: experimental_memorySecretStore(),
        onEvent: (event) => events.push(event),
        ...extra,
      },
    });

  it('returns a disposer from every registration and unloads in reverse order', async () => {
    const order: string[] = [];
    const definition = experimental_definePlugin({
      name: 'ordered',
      activate(context) {
        context.onDispose(() => {
          order.push('first');
        });
        const dispose = context.registerTool(echo('ordered_tool'));
        context.onDispose(() => {
          order.push('second');
        });
        context.registerCommand('hello', 'Hello $ARGUMENTS');
        expect(typeof dispose).toBe('function');
        return () => {
          order.push('activate');
        };
      },
    });
    const plugins = host([definition]);
    await plugins.load();
    expect(plugins.snapshot().tools.map((entry) => entry.name)).toEqual(['ordered_tool']);
    expect(plugins.snapshot().commands.map((entry) => entry.name)).toEqual(['ordered:hello']);
    await plugins.dispose();
    expect(order).toEqual(['activate', 'second', 'first']);
    expect(plugins.snapshot().tools).toEqual([]);
    expect(plugins.get('ordered@code')?.status).toBe('unloaded');
  });

  it('undoes a single registration with its disposer, at once', async () => {
    let dispose: (() => void | Promise<void>) | undefined;
    const plugins = host([
      {
        name: 'single',
        activate(context) {
          dispose = context.registerTool(echo('single_tool'));
        },
      },
    ]);
    await plugins.load();
    const before = plugins.snapshot();
    expect(before.tools).toHaveLength(1);
    await dispose?.();
    expect(plugins.snapshot().tools).toEqual([]);
    expect(plugins.snapshot().version).toBeGreaterThan(before.version);
    await plugins.dispose();
  });

  it('runs every disposer when one throws', async () => {
    const ran: string[] = [];
    const plugins = host([
      {
        name: 'throwing',
        activate(context) {
          context.onDispose(() => {
            ran.push('a');
          });
          context.onDispose(() => {
            throw new Error('boom');
          });
          context.onDispose(() => {
            ran.push('c');
          });
        },
      },
    ]);
    await plugins.load();
    await plugins.dispose();
    expect(ran).toEqual(['c', 'a']);
    expect(plugins.get('throwing@code')?.diagnostics.map((entry) => entry.message)).toContain(
      'A disposer (onDispose) failed: boom'
    );
  });

  it('keeps the old generation when a hot reload fails, and swaps when it works', async () => {
    let attempt = 0;
    const disposed: number[] = [];
    const plugins = host([
      {
        name: 'flaky',
        activate(context) {
          attempt++;
          const generation = attempt;
          if (generation === 2) {
            context.registerTool(echo('flaky_half'));
            throw new Error('the second generation is broken');
          }
          context.registerTool(echo(`flaky_v${generation}`));
          context.onDispose(() => {
            disposed.push(generation);
          });
        },
      },
    ]);
    await plugins.load();
    expect(plugins.get('flaky@code')).toMatchObject({ status: 'active', generation: 1 });
    const failed = await plugins.reload('flaky@code');
    expect(failed).toEqual([
      {
        id: 'flaky@code',
        ok: false,
        generation: 1,
        error: 'the second generation is broken',
        code: ErrorCode.PLUGIN_RELOAD_FAILED,
      },
    ]);
    expect(plugins.snapshot().tools.map((entry) => entry.name)).toEqual(['flaky_v1']);
    expect(plugins.get('flaky@code')).toMatchObject({ status: 'active', generation: 1 });
    expect(events).toContainEqual({
      type: 'reload-failed',
      plugin: 'flaky@code',
      generation: 2,
      error: 'the second generation is broken',
    });
    const worked = await plugins.reload('flaky@code');
    expect(worked).toEqual([{ id: 'flaky@code', ok: true, generation: 2 }]);
    expect(plugins.snapshot().tools.map((entry) => entry.name)).toEqual(['flaky_v3']);
    expect(disposed).toEqual([1]);
    await plugins.dispose();
    expect(disposed).toEqual([1, 3]);
  });

  it('activates plugins after the plugins they depend on', async () => {
    const order: string[] = [];
    const make = (name: string, dependencies: string[] = []): PluginDefinition => ({
      name,
      version: '1.0.0',
      dependencies: dependencies.map((dependency) => ({ name: dependency })),
      activate() {
        order.push(name);
      },
    });
    const plugins = host([make('app', ['ui', 'data']), make('ui', ['data']), make('data')]);
    await plugins.load();
    expect(order).toEqual(['data', 'ui', 'app']);
    expect(plugins.list().map((entry) => entry.id)).toEqual(['data@code', 'ui@code', 'app@code']);
    await plugins.dispose();
  });

  it('blocks every plugin of a dependency cycle and what depends on it', async () => {
    const plugins = host([
      { name: 'left', dependencies: [{ name: 'right' }] },
      { name: 'right', dependencies: [{ name: 'left' }] },
      { name: 'above', dependencies: [{ name: 'left' }] },
      { name: 'free' },
    ]);
    await plugins.load();
    expect(plugins.get('left@code')).toMatchObject({ status: 'blocked' });
    expect(plugins.get('left@code')?.error).toMatch(
      /cycle: left@code -> right@code -> left@code|cycle: right@code -> left@code -> right@code/
    );
    expect(plugins.get('right@code')?.status).toBe('blocked');
    expect(plugins.get('above@code')).toMatchObject({ status: 'blocked' });
    expect(plugins.get('above@code')?.error).toMatch(
      /needs the plugin left@code, which cannot load/
    );
    expect(plugins.get('free@code')?.status).toBe('active');
    await plugins.dispose();
  });

  it('blocks a plugin whose dependency is missing or disabled, a local copy satisfying any range', async () => {
    const plugins = new experimental_PluginHost({
      root: base,
      config: {
        plugins: [
          { name: 'needs-missing', dependencies: [{ name: 'nowhere' }] },
          { name: 'needs-off', dependencies: [{ name: 'off' }] },
          { name: 'off' },
          { name: 'needs-new', dependencies: [{ name: 'old', version: '^2.0.0' }] },
          { name: 'old', version: '1.4.0' },
          { name: 'needs-old', dependencies: [{ name: 'old', version: '~1.4.0' }] },
        ],
        enabled: { 'off@code': false },
        installed: false,
      },
    });
    await plugins.load();
    expect(plugins.get('needs-missing@code')?.error).toBe(
      'needs-missing@code needs the plugin nowhere, which is not installed'
    );
    expect(plugins.get('needs-off@code')?.error).toBe(
      'needs-off@code needs the plugin off@code, which is disabled'
    );
    expect(plugins.get('needs-new@code')?.status).toBe('active');
    expect(plugins.get('needs-old@code')?.status).toBe('active');
    expect(plugins.get('off@code')).toMatchObject({ status: 'disabled', enabledBy: 'session' });
    await plugins.dispose();
  });

  it('checks a version range against an installed dependency, and lets a local copy stand in for a marketplace', async () => {
    const pluginsRoot = join(base, '.plugins');
    const lib = join(pluginsRoot, 'cache', 'mkt', 'lib', '1.4.0');
    mkdirSync(join(lib, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(lib, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'lib', version: '1.4.0' })
    );
    await writeInstalledPlugins(pluginsRoot, [
      {
        id: 'lib@mkt',
        name: 'lib',
        marketplace: 'mkt',
        version: '1.4.0',
        installPath: lib,
        source: { source: 'path', path: './lib' },
        pin: {},
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      },
    ]);
    const plugins = host([
      { name: 'wants-two', dependencies: [{ name: 'lib', marketplace: 'mkt', version: '^2.0.0' }] },
      { name: 'wants-one', dependencies: [{ name: 'lib', marketplace: 'mkt', version: '^1.2.0' }] },
      { name: 'helper' },
      { name: 'wants-helper', dependencies: [{ name: 'helper', marketplace: 'elsewhere' }] },
    ]);
    await plugins.load();
    expect(plugins.get('wants-two@code')?.error).toBe('Requires "lib@mkt" ^2.0.0, installed 1.4.0');
    expect(plugins.get('wants-one@code')?.status).toBe('active');
    expect(plugins.get('wants-helper@code')?.status).toBe('active');
    await plugins.dispose();
  });

  it('blocks the plugins that depend on one that fails to activate', async () => {
    const activated: string[] = [];
    const plugins = host([
      {
        name: 'broken',
        activate() {
          activated.push('broken');
          throw new Error('no database');
        },
      },
      {
        name: 'consumer',
        dependencies: [{ name: 'broken' }],
        activate() {
          activated.push('consumer');
        },
      },
      {
        name: 'top',
        dependencies: [{ name: 'consumer' }],
        activate() {
          activated.push('top');
        },
      },
    ]);
    await plugins.load();
    expect(activated).toEqual(['broken']);
    expect(plugins.get('broken@code')?.status).toBe('failed');
    expect(plugins.get('consumer@code')).toMatchObject({ status: 'blocked' });
    expect(plugins.get('consumer@code')?.error).toBe(
      'consumer@code needs the plugin broken@code, which did not load: no database'
    );
    expect(plugins.get('top@code')?.status).toBe('blocked');
    await plugins.dispose();
  });

  it('unloads a plugin before the plugins it depends on', async () => {
    const log: string[] = [];
    const tracked = (name: string, dependencies: { name: string }[] = []) => ({
      name,
      dependencies,
      activate() {
        log.push(`${name} on`);
        return () => {
          log.push(`${name} off`);
        };
      },
    });
    const plugins = host([tracked('base'), tracked('app', [{ name: 'base' }])]);
    await plugins.load();
    await plugins.setEnabled('base@code', false);
    expect(log).toEqual(['base on', 'app on', 'app off', 'base off']);
    await plugins.setEnabled('base@code', true);
    log.length = 0;
    await plugins.dispose();
    expect(log).toEqual(['app off', 'base off']);
  });

  it('lets a disabled plugin shadow nothing, the enabled one of the name loading', async () => {
    const dir = join(base, 'twin');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'twin' }));
    const plugins = new experimental_PluginHost({
      root: base,
      config: {
        plugins: [{ name: 'twin' }],
        dirs: [dir],
        enabled: { 'twin@code': false },
        installed: false,
        secrets: experimental_memorySecretStore(),
      },
    });
    await plugins.load();
    expect(plugins.get('twin@code')?.status).toBe('disabled');
    expect(plugins.get('twin@inline')?.status).toBe('active');
    await plugins.setEnabled('twin@code', true);
    expect(plugins.get('twin@code')?.status).toBe('active');
    expect(plugins.get('twin@inline')).toMatchObject({
      status: 'disabled',
      error: 'The name "twin" is taken by twin@code, which takes precedence',
    });
    await plugins.dispose();
  });

  it('keeps the old generation when a reload fails to start an MCP server', async () => {
    let connects = 0;
    const lookup = echo('remote_lookup');
    const plugins = new experimental_PluginHost({
      root: base,
      config: {
        plugins: [
          {
            name: 'remote',
            activate(context) {
              context.registerMcpServer('api', { command: 'api-server' });
            },
          },
        ],
        installed: false,
        secrets: experimental_memorySecretStore(),
        mcp: async () => {
          if (++connects > 1) throw new Error('connection refused');
          return { tools: [lookup], close: async () => undefined };
        },
      },
    });
    await plugins.load();
    expect(plugins.snapshot().tools.map((entry) => entry.name)).toEqual(['remote_lookup']);
    const [result] = await plugins.reload('remote@code');
    expect(result).toMatchObject({
      id: 'remote@code',
      ok: false,
      generation: 1,
      code: ErrorCode.PLUGIN_RELOAD_FAILED,
    });
    expect(result?.error).toMatch(/did not start: connection refused/);
    expect(plugins.snapshot().tools.map((entry) => entry.name)).toEqual(['remote_lookup']);
    await plugins.dispose();
  });

  it('does nothing for a reload asked for before dispose', async () => {
    let activations = 0;
    const plugins = host([
      {
        name: 'late',
        activate() {
          activations++;
        },
      },
    ]);
    await plugins.load();
    const reloaded = plugins.reload();
    await plugins.dispose();
    expect(await reloaded).toEqual([]);
    expect(activations).toBe(1);
    expect(plugins.get('late@code')?.status).toBe('unloaded');
  });

  it('puts the project folder in for ${CLAUDE_PROJECT_DIR}', async () => {
    const plugins = host([
      {
        name: 'paths',
        activate(context) {
          context.registerCommand('where', 'Work in ${CLAUDE_PROJECT_DIR}/src');
        },
      },
    ]);
    await plugins.load();
    expect(plugins.snapshot().commands[0]?.template).toBe(`Work in ${base}/src`);
    await plugins.dispose();
  });

  it('never adds hooks whose disposer ran before their checks finished', async () => {
    const plugins = host([
      {
        name: 'fleeting',
        activate(context) {
          const dispose = context.registerHooks({
            Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
          });
          void dispose();
        },
      },
    ]);
    await plugins.load();
    expect(plugins.snapshot().hooks).toEqual([]);
    await plugins.dispose();
  });

  it('enables a dependency nobody set, and loads and unloads plugins switched on and off', async () => {
    const plugins = host([
      { name: 'base-lib', defaultEnabled: false },
      { name: 'user', dependencies: [{ name: 'base-lib' }] },
      { name: 'optional', defaultEnabled: false },
    ]);
    await plugins.load();
    expect(plugins.get('base-lib@code')?.status).toBe('active');
    expect(plugins.get('optional@code')?.status).toBe('disabled');
    await plugins.setEnabled('optional@code', true);
    expect(plugins.get('optional@code')?.status).toBe('active');
    await plugins.setEnabled('optional@code', false);
    expect(plugins.get('optional@code')?.status).toBe('disabled');
    await plugins.dispose();
  });

  it('reloads a folder plugin generation by generation, keeping the old one when the new manifest breaks', async () => {
    const dir = join(base, 'folder-plugin');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'folder', version: '1.0.0' })
    );
    writeFileSync(join(dir, 'commands', 'one.md'), 'One.');
    const plugins = host([], { dirs: [dir] });
    await plugins.load();
    expect(plugins.snapshot().commands.map((entry) => entry.name)).toEqual(['folder:one']);
    writeFileSync(join(dir, 'commands', 'two.md'), 'Two.');
    expect(await plugins.reload('folder@inline')).toEqual([
      { id: 'folder@inline', ok: true, generation: 2 },
    ]);
    expect(
      plugins
        .snapshot()
        .commands.map((entry) => entry.name)
        .sort()
    ).toEqual(['folder:one', 'folder:two']);
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'folder', homepage: 'not a url' })
    );
    const [result] = await plugins.reload('folder@inline');
    expect(result).toMatchObject({ id: 'folder@inline', ok: false, generation: 2 });
    expect(
      plugins
        .snapshot()
        .commands.map((entry) => entry.name)
        .sort()
    ).toEqual(['folder:one', 'folder:two']);
    expect(plugins.get('folder@inline')?.version).toBe('1.0.0');
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ "name": "folder",');
    const [broken] = await plugins.reload('folder@inline');
    expect(broken).toMatchObject({
      id: 'folder@inline',
      ok: false,
      generation: 2,
      code: ErrorCode.PLUGIN_RELOAD_FAILED,
    });
    expect(plugins.list().map((entry) => entry.id)).toEqual(['folder@inline']);
    expect(plugins.snapshot().commands).toHaveLength(2);
    await plugins.dispose();
  });

  it(
    'reloads a folder plugin by itself when watch is on and a file of it changes',
    { timeout: 15_000 },
    async () => {
      const dir = join(base, 'watched');
      mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
      mkdirSync(join(dir, 'commands'), { recursive: true });
      writeFileSync(
        join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'watched' })
      );
      writeFileSync(join(dir, 'commands', 'first.md'), 'First.');
      const plugins = new experimental_PluginHost({
        root: base,
        config: {
          dirs: [dir],
          installed: false,
          watch: { debounceMs: 30 },
          onEvent: (event) => events.push(event),
        },
      });
      await plugins.load();
      const deadline = Date.now() + 10_000;
      let writes = 0;
      while (
        Date.now() < deadline &&
        !events.some((event) => event.type === 'loaded' && event.generation === 2)
      ) {
        writeFileSync(join(dir, 'commands', 'second.md'), `Second ${++writes}.`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(
        plugins
          .snapshot()
          .commands.map((entry) => entry.name)
          .sort()
      ).toEqual(['watched:first', 'watched:second']);
      await plugins.dispose();
    }
  );

  it('refuses two registrations of one name in a plugin and leaves the plugin failed', async () => {
    const plugins = host([
      {
        name: 'twice',
        activate(context) {
          context.registerTool(echo('dup_tool'));
          context.registerTool(echo('dup_tool'));
        },
      },
    ]);
    await plugins.load();
    expect(plugins.get('twice@code')).toMatchObject({
      status: 'failed',
      error: 'Plugin twice@code registered the tool dup_tool twice',
    });
    expect(plugins.snapshot().tools).toEqual([]);
    await plugins.dispose();
  });

  it('keeps the first of two plugins that register one tool name', async () => {
    const plugins = host([
      { name: 'first', activate: (context) => void context.registerTool(echo('shared_tool')) },
      { name: 'second', activate: (context) => void context.registerTool(echo('shared_tool')) },
    ]);
    await plugins.load();
    const [only] = plugins.snapshot().tools;
    expect(
      await only?.execute(
        { text: 'x' },
        { agentId: 'a', runId: 'r', signal: new AbortController().signal }
      )
    ).toBe('shared_tool: x');
    expect(plugins.get('second@code')?.diagnostics.map((entry) => entry.message)).toContain(
      'The tool shared_tool is taken by a plugin that loaded earlier, this one is left out'
    );
    await plugins.dispose();
  });

  it('fails a plugin whose engines.cogitator range does not include this version', async () => {
    const plugins = new experimental_PluginHost({
      root: base,
      cogitatorVersion: '0.70.0',
      config: {
        plugins: [{ name: 'future', engines: { cogitator: '>=1.0.0' } }],
        installed: false,
      },
    });
    await plugins.load();
    expect(plugins.get('future@code')).toMatchObject({
      status: 'failed',
      error: 'The plugin works with Cogitator >=1.0.0, this is 0.70.0',
    });
    await plugins.dispose();
  });

  it('refuses an invalid plugin name in code with a configuration error', async () => {
    const plugins = host([{ name: 'bad name' }]);
    await expect(plugins.load()).rejects.toMatchObject({ code: ErrorCode.CONFIGURATION_ERROR });
    expect(() => experimental_definePlugin({ name: 'a:b' })).toThrow(
      /separates the plugin from its components/
    );
  });
});
