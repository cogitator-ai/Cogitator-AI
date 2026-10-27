import type { Cogitator, experimental_PluginHost, PluginReloadResult } from '@cogitator-ai/core';
import type { PluginInfo } from '@cogitator-ai/types';
import type {
  PluginActionResult,
  PluginPanelCallResult,
  PluginRecord,
  PluginReloadRecord,
  PluginsState,
} from '../protocol.js';

/** A plugin request the host refuses, with the code the server answers it by. */
export class PluginRefusal extends Error {
  constructor(
    message: string,
    readonly code:
      'PLUGINS_UNAVAILABLE' | 'PLUGINS_NOT_CONFIGURED' | 'PLUGIN_NOT_FOUND' | 'VALIDATION_ERROR'
  ) {
    super(message);
    this.name = 'PluginRefusal';
  }
}

const HOST_METHODS = [
  'load',
  'list',
  'get',
  'reload',
  'setEnabled',
  'onChange',
  'panelHtml',
  'callPanel',
];

/** Whether the runtime has a plugin host: a project on a core older than plugins has none. */
function isPluginHost(value: unknown): value is experimental_PluginHost {
  if (typeof value !== 'object' || value === null) return false;
  const methods = value as Record<string, unknown>;
  return HOST_METHODS.every((name) => typeof methods[name] === 'function');
}

/** `value` as plain JSON, `null` for what JSON cannot hold. */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return String(value);
  }
}

/** A plugin as the studio's pages show it, a JSON copy of what the runtime knows. */
export function pluginRecord(info: PluginInfo): PluginRecord {
  const { contributions } = info;
  return {
    id: info.id,
    name: info.name,
    ...(info.displayName !== undefined && { displayName: info.displayName }),
    ...(info.version !== undefined && { version: info.version }),
    ...(info.description !== undefined && { description: info.description }),
    origin: info.origin,
    format: info.format,
    ...(info.root !== undefined && { root: info.root }),
    enabled: info.enabled,
    enabledBy: info.enabledBy,
    status: info.status,
    ...(info.error !== undefined && { error: info.error }),
    generation: info.generation,
    isolated: info.isolated,
    dependencies: info.dependencies.map((dependency) => ({
      name: dependency.name,
      ...(dependency.marketplace !== undefined && { marketplace: dependency.marketplace }),
      ...(dependency.version !== undefined && { version: dependency.version }),
    })),
    ...(info.permissions && {
      permissions: {
        allow: [...(info.permissions.allow ?? [])],
        deny: [...(info.permissions.deny ?? [])],
      },
    }),
    contributions: {
      tools: [...contributions.tools],
      skills: [...contributions.skills],
      agents: [...contributions.agents],
      commands: [...contributions.commands],
      hooks: contributions.hooks,
      mcpServers: [...contributions.mcpServers],
      llmBackends: [...contributions.llmBackends],
      middleware: contributions.middleware,
      panels: contributions.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        ...(panel.description !== undefined && { description: panel.description }),
        ...(panel.icon !== undefined && { icon: panel.icon }),
      })),
      routines: [...(contributions.routines ?? [])],
    },
    diagnostics: info.diagnostics.map((diagnostic) => ({
      level: diagnostic.level,
      message: diagnostic.message,
      ...(diagnostic.path !== undefined && { path: diagnostic.path }),
    })),
  };
}

function reloadRecord(result: PluginReloadResult): PluginReloadRecord {
  return {
    id: result.id,
    ok: result.ok,
    generation: result.generation,
    ...(result.error !== undefined && { error: result.error }),
  };
}

/**
 * The plugins of the project's runtime for the studio: lists them, reloads, enables and disables
 * them, serves the pages of their panels and calls the panels' handlers. Every change the runtime
 * makes to its plugins is reported through `onChange`.
 */
export class ProjectPlugins {
  private pending = false;
  private stop?: () => void;

  private constructor(
    private readonly host: experimental_PluginHost | undefined,
    private readonly configured: boolean,
    onChange: (state: PluginsState) => void
  ) {
    if (!host) return;
    this.stop = host.onChange(() => {
      if (this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        onChange(this.state());
      });
    });
  }

  /**
   * The plugins of `cogitator`, loaded as its first run would load them. A runtime loads plugins
   * only when it configures `experimental_plugins` (`configured`), so installed plugins do not show
   * up in a project that did not ask for them: such a runtime keeps only the core's own plugin
   */
  static async open(
    cogitator: Cogitator,
    onChange: (state: PluginsState) => void
  ): Promise<ProjectPlugins> {
    const candidate: unknown = cogitator.experimental_plugins;
    if (!isPluginHost(candidate)) return new ProjectPlugins(undefined, false, onChange);
    if (candidate.configured) {
      try {
        await candidate.load();
      } catch (error) {
        console.error(
          `[studio host] could not load the plugins of the project: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return new ProjectPlugins(candidate, candidate.configured, onChange);
  }

  state(): PluginsState {
    return {
      available: this.host !== undefined,
      configured: this.configured,
      plugins: this.host ? this.host.list().map(pluginRecord) : [],
    };
  }

  /** Builds the plugin again: a reload that fails keeps the generation that works. */
  async reload(id: string): Promise<PluginActionResult> {
    const host = this.changeable(id);
    const results = await host.reload(id);
    return { results: results.map(reloadRecord), plugins: this.state() };
  }

  /** Turns the plugin on or off for this runtime, over the settings files. */
  async setEnabled(id: string, enabled: boolean): Promise<PluginActionResult> {
    const host = this.changeable(id);
    if (host.get(id)?.origin === 'core') {
      throw new PluginRefusal(
        `${id} is the core's own plugin, it is always on`,
        'VALIDATION_ERROR'
      );
    }
    const results = await host.setEnabled(id, enabled);
    return { results: results.map(reloadRecord), plugins: this.state() };
  }

  async panelHtml(plugin: string, panel: string): Promise<{ html: string }> {
    return { html: await this.loaded().panelHtml(plugin, panel) };
  }

  /** Calls a handler of a panel, as its page asks, and returns what it gave as JSON. */
  async call(
    plugin: string,
    panel: string,
    method: string,
    params: unknown
  ): Promise<PluginPanelCallResult> {
    return { result: plain(await this.loaded().callPanel(plugin, panel, method, params)) };
  }

  close(): void {
    this.stop?.();
    this.stop = undefined;
  }

  private loaded(): experimental_PluginHost {
    if (!this.host) {
      throw new PluginRefusal(
        'The project runs a @cogitator-ai/core without plugins',
        'PLUGINS_UNAVAILABLE'
      );
    }
    return this.host;
  }

  private changeable(id: string): experimental_PluginHost {
    const host = this.loaded();
    if (!this.configured) {
      throw new PluginRefusal(
        'The project configures no experimental_plugins, so its runtime has only the core plugin and nothing to reload, enable or disable',
        'PLUGINS_NOT_CONFIGURED'
      );
    }
    if (!host.get(id)) {
      throw new PluginRefusal(`No plugin ${id} is known to the runtime`, 'PLUGIN_NOT_FOUND');
    }
    return host;
  }
}
