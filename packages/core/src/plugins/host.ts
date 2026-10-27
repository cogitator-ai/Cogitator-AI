/**
 * The plugin host of a runtime: finds plugins (the core's own, the host's code, plugin folders,
 * installed plugins), decides which are enabled, loads them in the order of their dependencies
 * and keeps a generation of each that loaded in full. A reload builds a new generation next to
 * the old one and swaps them only once the new one loaded, so a plugin that fails to reload goes
 * on as it was
 */

import { mkdir, readFile, realpath } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import {
  CogitatorError,
  ErrorCode,
  type CommandDefinition,
  type CommandDefinitionInput,
  type HookEventName,
  type HookMatcherGroup,
  type HookSettings,
  type InstalledPluginRecord,
  type LLMPlugin,
  type PermissionLayer,
  type PluginContext,
  type PluginContributions,
  type PluginDefinition,
  type PluginDependency,
  type PluginDiagnostic,
  type PluginDisposer,
  type PluginHostEvent,
  type PluginInfo,
  type PluginManifest,
  type PluginMcpServerConfig,
  type PluginOptionSpec,
  type PluginOptionValue,
  type PluginOrigin,
  type PluginPanelContribution,
  type PluginPermissionsSpec,
  type PluginSecretStore,
  type PluginSettingsOptions,
  type PluginSkillSpec,
  type PluginsConfig,
  type PluginStatus,
  type PluginToolSpec,
  type RunMiddleware,
  type SubagentDefinition,
  type SubagentDefinitionInput,
  type Tool,
} from '@cogitator-ai/types';
import { getLogger, type Logger } from '../logger';
import { readHookSettings } from '../hooks/settings';
import { stringify as stringifyYaml } from 'yaml';
import { readFrontmatter } from '../skills/frontmatter';
import { parseCommandFile, parseSubagentFile } from '../subagents/definitions';
import { loaderVariableOf, PluginPermissions, pluginCapabilities } from './capabilities';
import {
  Generation,
  isBuiltTool,
  toolFromSpec,
  type PluginLease,
  type PluginPanelEntry,
  type PluginSnapshot,
} from './contributions';
import { IsolatedPluginProcess } from './isolated/process';
import { isInside, pluginNameProblem, readPluginLayout, type PluginLayout } from './manifest';
import { experimental_keychainSecretStore, secretServiceOf } from './secrets';
import { satisfies } from './semver';
import { loadPluginSettings, type PluginSettings } from './settings';
import { PluginCodeSkills, PluginFolderSkills, PLUGIN_SKILL_NAME } from './skills';
import { defaultPluginsRoot, pluginDataDir, readInstalledPlugins } from './store';
import {
  pluginEnvironment,
  referencesOptions,
  substitute,
  substituteServer,
  type PluginVariables,
} from './variables';

/** A segment of a plugin component's name, as Claude Code's subagent names are written */
const COMPONENT_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** A command name after the plugin's: letters, digits, `-`, `_` and `:` between parts */
const COMMAND_NAME = /^[^\s/:<>][^\s/<>]*$/;

const PANEL_ID = /^[A-Za-z0-9_-]+$/;

const DEFAULT_WATCH_DEBOUNCE_MS = 300;

/** What the host is built with */
export interface PluginHostOptions {
  /** The plugins of the runtime, see `CogitatorConfig.experimental_plugins` */
  config?: PluginsConfig;
  /** The project root: where settings files, the plugins' relative file paths and trust start */
  root?: string;
  /**
   * Where `enabledPlugins` and `pluginConfigs` are read, resolved with the places and trust of
   * `permissions.settings`. Unset, no settings file is read
   */
  settings?: PluginSettingsOptions;
  /** The core's own plugins, loaded at once and never off */
  core?: readonly PluginDefinition[];
  /** The version of Cogitator, for the plugins' `engines.cogitator` */
  cogitatorVersion?: string;
  logger?: Logger;
}

/** How a reload went for one plugin */
export interface PluginReloadResult {
  id: string;
  ok: boolean;
  /** The generation that serves now: the new one, or the old one after a failure (0 for none) */
  generation: number;
  error?: string;
  /**
   * Why it failed: `PLUGIN_RELOAD_FAILED` when the previous generation goes on, else the code of
   * the failure of a first load (`PLUGIN_INVALID`, `PLUGIN_ACTIVATION_FAILED`, ...)
   */
  code?: ErrorCode;
}

/** A plugin the host found, before deciding whether it loads */
interface Candidate {
  id: string;
  name: string;
  origin: PluginOrigin;
  definition?: PluginDefinition;
  dir?: string;
  record?: InstalledPluginRecord;
  layout?: PluginLayout;
  /** The marketplace part of the id, which bare dependency names resolve in */
  marketplace: string;
}

/** Everything the host keeps about a plugin */
interface PluginState {
  candidate: Candidate;
  manifest: PluginManifest;
  format: PluginInfo['format'];
  enabled: boolean;
  enabledBy: PermissionLayer | 'default';
  status: PluginStatus;
  error?: string;
  diagnostics: PluginDiagnostic[];
  generation?: Generation;
  generations: number;
  isolated: boolean;
  /** The plugin of the same name that loads instead of this one */
  shadowedBy?: string;
}

/** What a plugin is found as now, put on its state once a generation of it loads */
interface Found {
  candidate: Candidate;
  manifest: PluginManifest;
  format: PluginInfo['format'];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hosts the plugins of a runtime. Every registration of a plugin, whether the plugin is the
 * core's, the host's code or a third party's, goes through the same `PluginContext`, and every
 * one returns its disposer. A plugin's generation unloads its registrations in reverse order
 *
 * @example
 * ```ts
 * const host = new experimental_PluginHost({ config: { dirs: ['./plugins/review'] } });
 * await host.load();
 * console.log(host.list().map((plugin) => `${plugin.id} ${plugin.status}`));
 * await host.dispose();
 * ```
 */
export class experimental_PluginHost {
  private readonly config: PluginsConfig;
  private readonly root: string;
  private readonly logger: Logger;
  private readonly store: PluginSecretStore;
  private readonly states = new Map<string, PluginState>();
  /** The live plugins, in the order they loaded */
  private readonly order: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly reported = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();
  private snapshotCache?: PluginSnapshot;
  /** The generations `snapshotCache` was taken from */
  private snapshotGenerations: Generation[] = [];
  /** What the plugins a reconcile rebuilds are found as now, before their build */
  private next: ReadonlyMap<string, Found> = new Map();
  /** Retired generations runs still hold, unloaded once the last one lets them go */
  private readonly draining = new Map<Generation, string>();
  private version = 0;
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** Bumped by `dispose()`: reloads asked for before it do nothing after it */
  private epoch = 0;
  private settings?: PluginSettings;
  private readonly pluginsRoot: string;

  constructor(private readonly options: PluginHostOptions = {}) {
    this.config = options.config ?? {};
    this.root = resolve(options.root ?? process.cwd());
    this.logger = options.logger ?? getLogger();
    this.store = this.config.secrets ?? experimental_keychainSecretStore();
    this.pluginsRoot =
      typeof this.config.installed === 'object'
        ? resolve(this.config.installed.root)
        : defaultPluginsRoot();
    for (const definition of options.core ?? []) this.loadCore(definition);
  }

  /** The folder installed plugins are kept in */
  get installedRoot(): string {
    return this.pluginsRoot;
  }

  /**
   * Whether the host was given plugins to load (`experimental_plugins` of the runtime). Without
   * them only the core's own plugin is there, and a runtime never calls `load()`
   */
  get configured(): boolean {
    return this.options.config !== undefined;
  }

  /**
   * Loads every enabled plugin once, in the order of their dependencies. Later calls wait for the
   * same load. A plugin that fails is kept as `failed` with its error, the others load anyway
   */
  load(): Promise<void> {
    this.loading ??= this.serial(() => this.reconcile('none')).then(() => undefined);
    return this.loading;
  }

  /** The plugins the host knows, in the order they loaded, then the ones that did not */
  list(): PluginInfo[] {
    const ids = [
      ...this.order,
      ...[...this.states.keys()].filter((id) => !this.order.includes(id)),
    ];
    return ids.flatMap((id) => {
      const state = this.states.get(id);
      return state ? [this.infoOf(state)] : [];
    });
  }

  /** The plugin `id` (`name@marketplace`), undefined when the host does not know it */
  get(id: string): PluginInfo | undefined {
    const state = this.states.get(id);
    return state ? this.infoOf(state) : undefined;
  }

  /** Every problem found in a plugin, in the order found */
  diagnostics(): PluginDiagnostic[] {
    return [...this.states.values()].flatMap((state) => state.diagnostics);
  }

  /**
   * Builds the plugin `id` again (every plugin without one, picking up plugins enabled, disabled,
   * installed or removed since): a new generation loads beside the old one, and replaces it only
   * once it loaded in full. A generation that fails is unloaded and the old one serves on, with
   * `PLUGIN_RELOAD_FAILED` in the result
   */
  reload(id?: string): Promise<PluginReloadResult[]> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (epoch !== this.epoch) return [];
      if (id !== undefined && !this.states.has(id)) {
        throw new CogitatorError({
          message: `No plugin ${id} is known to the host`,
          code: ErrorCode.PLUGIN_NOT_FOUND,
        });
      }
      return this.reconcile(id ?? 'all');
    });
  }

  /**
   * Turns the plugin `id` on or off for this host, over the settings files (as
   * `experimental_plugins.enabled` does), and loads or unloads it. Managed settings still win
   */
  async setEnabled(id: string, enabled: boolean): Promise<PluginReloadResult[]> {
    const current = this.config.enabled ?? {};
    (this.config as { enabled?: Record<string, boolean> }).enabled = { ...current, [id]: enabled };
    const epoch = this.epoch;
    return this.serial(async () => (epoch === this.epoch ? this.reconcile('none') : []));
  }

  /** Hears every change of what the live plugins add. Returns what stops it */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What the live generations add, the same object until something changes */
  snapshot(): PluginSnapshot {
    if (this.snapshotCache) return this.snapshotCache;
    const tools = new Map<string, Tool>();
    const agents = new Map<string, SubagentDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const backends = new Map<string, LLMPlugin>();
    const backendOwners = new Map<string, string>();
    const skills = [];
    const hooks = [];
    const middleware: RunMiddleware[] = [];
    const panels: PluginPanelEntry[] = [];
    const generations: Generation[] = [];
    for (const id of this.order) {
      const generation = this.states.get(id)?.generation;
      if (!generation?.live) continue;
      generations.push(generation);
      const set = generation.contributions;
      for (const [name, tool] of set.tools) {
        const taken = tools.get(name);
        if (taken && taken !== tool) {
          this.report(
            id,
            'warning',
            `The tool ${name} is taken by a plugin that loaded earlier, this one is left out`
          );
          continue;
        }
        tools.set(name, tool);
      }
      for (const [name, definition] of set.agents)
        if (!agents.has(name)) agents.set(name, definition);
      for (const [name, definition] of set.commands) {
        if (!commands.has(name)) commands.set(name, definition);
      }
      for (const [provider, backend] of set.backends) {
        if (backends.has(provider)) {
          this.report(
            id,
            'warning',
            `The LLM provider ${provider} is taken by a plugin that loaded earlier, this one is left out`
          );
          continue;
        }
        backends.set(provider, backend);
        backendOwners.set(provider, id);
      }
      skills.push(...set.skills);
      if (set.codeSkills && set.codeSkills.size > 0) skills.push(set.codeSkills);
      hooks.push(...set.hooks);
      middleware.push(...set.middleware);
      panels.push(...set.panels.values());
    }
    this.snapshotCache = {
      version: this.version,
      tools: [...tools.values()],
      skills,
      agents: [...agents.values()],
      commands: [...commands.values()],
      hooks,
      middleware,
      backends,
      backendOwners,
      panels,
    };
    this.snapshotGenerations = generations;
    return this.snapshotCache;
  }

  /**
   * The snapshot for one run, its generations held until `release()`: a reload during the run
   * swaps in the new generation for later runs, and the one this run uses (its tools, skills,
   * process) unloads only once every run that holds it let it go
   */
  lease(): PluginLease {
    const snapshot = this.snapshot();
    const held = [...this.snapshotGenerations];
    for (const generation of held) generation.hold();
    let released = false;
    return {
      snapshot,
      release: () => {
        if (released) return;
        released = true;
        for (const generation of held) generation.letGo();
      },
    };
  }

  /** The page of a panel: its HTML file, or the page it was registered with */
  async panelHtml(plugin: string, panel: string): Promise<string> {
    const entry = this.panelOf(plugin, panel);
    if (entry.html !== undefined) return entry.html;
    if (entry.path === undefined) {
      throw new CogitatorError({
        message: `Panel ${panel} has no page`,
        code: ErrorCode.PLUGIN_INVALID,
      });
    }
    return readFile(entry.path, 'utf8');
  }

  /** Calls the handler `method` of a panel with `params`, as its page asks */
  async callPanel(
    plugin: string,
    panel: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const handler = Object.hasOwn(this.panelOf(plugin, panel).handlers, method)
      ? this.panelOf(plugin, panel).handlers[method]
      : undefined;
    if (!handler) {
      throw new CogitatorError({
        message: `Panel ${panel} of ${plugin} has no handler ${method}`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return handler(params);
  }

  /**
   * Unloads every plugin but the core's, in the reverse order they loaded, and stops watching
   * their folders. A later `load()` loads them again
   */
  dispose(): Promise<void> {
    this.epoch++;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    return this.serial(async () => {
      this.disposed = true;
      for (const id of this.unloadOrder(this.order)) {
        const state = this.states.get(id);
        if (!state?.generation || state.candidate.origin === 'core') continue;
        await this.unload(state);
        state.status = 'unloaded';
      }
      for (const [generation, id] of [...this.draining]) await this.retire(id, generation, true);
      this.loading = undefined;
      this.disposed = false;
      this.changed();
    });
  }

  /**
   * `ids` in the order to unload them: every plugin before the plugins it depends on (the reverse
   * of the order they load in), so a dependency never goes while what needs it is still loaded
   */
  private unloadOrder(ids: readonly string[]): string[] {
    const wanted = new Set(ids);
    return this.resolveGraph()
      .order.filter((id) => wanted.has(id))
      .reverse();
  }

  private panelOf(plugin: string, panel: string): PluginPanelEntry {
    const entry = this.snapshot().panels.find(
      (candidate) => candidate.plugin === plugin && candidate.panel.id === panel
    );
    if (!entry) {
      throw new CogitatorError({
        message: `No panel ${panel} of plugin ${plugin} is loaded`,
        code: ErrorCode.PLUGIN_NOT_FOUND,
      });
    }
    return entry;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private changed(): void {
    this.version++;
    this.snapshotCache = undefined;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('A plugin change listener failed', { error: message(error) });
      }
    }
  }

  private emit(event: PluginHostEvent): void {
    try {
      this.config.onEvent?.(event);
    } catch (error) {
      this.logger.warn('experimental_plugins.onEvent failed', { error: message(error) });
    }
  }

  private report(
    plugin: string,
    level: PluginDiagnostic['level'],
    text: string,
    path?: string
  ): void {
    const diagnostic: PluginDiagnostic = { level, message: text, plugin, ...(path && { path }) };
    this.record(diagnostic);
  }

  private record(diagnostic: PluginDiagnostic): void {
    const key = `${diagnostic.plugin ?? ''}\n${diagnostic.path ?? ''}\n${diagnostic.message}`;
    const state = diagnostic.plugin ? this.states.get(diagnostic.plugin) : undefined;
    if (
      state &&
      !state.diagnostics.some(
        (kept) => kept.message === diagnostic.message && kept.path === diagnostic.path
      )
    ) {
      state.diagnostics.push(diagnostic);
    }
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const details = {
      plugin: diagnostic.plugin,
      ...(diagnostic.path && { path: diagnostic.path }),
    };
    if (diagnostic.level === 'error') this.logger.warn(`Plugin: ${diagnostic.message}`, details);
    else this.logger.debug(`Plugin: ${diagnostic.message}`, details);
    try {
      this.config.onDiagnostic?.(diagnostic);
    } catch (error) {
      this.logger.warn('experimental_plugins.onDiagnostic failed', { error: message(error) });
    }
  }

  /** Loads a plugin of the core at once: its `activate` may not wait for anything */
  private loadCore(definition: PluginDefinition): void {
    const id = `${definition.name}@builtin`;
    const candidate: Candidate = {
      id,
      name: definition.name,
      origin: 'core',
      definition,
      marketplace: 'builtin',
    };
    const state: PluginState = {
      candidate,
      manifest: definition,
      format: 'code',
      enabled: true,
      enabledBy: 'default',
      status: 'active',
      diagnostics: [],
      generations: 0,
      isolated: false,
    };
    this.states.set(id, state);
    const generation = new Generation(++state.generations, () => this.changed());
    const context = this.contextOf(state, generation, this.variablesOf(state, {}, {}), undefined);
    const returned = definition.activate?.(context);
    if (returned instanceof Promise) {
      throw new TypeError(`The core plugin ${definition.name} must activate without waiting`);
    }
    if (typeof returned === 'function') generation.track(returned, 'activate');
    generation.live = true;
    state.generation = generation;
    this.order.push(id);
    this.changed();
  }

  /** Finds the plugins the host has: code, folders and installed ones, the first of a name winning */
  private async discover(): Promise<Candidate[]> {
    const found: Candidate[] = [];
    for (const definition of this.config.plugins ?? []) {
      const problem = pluginNameProblem(definition.name);
      if (problem) {
        throw new CogitatorError({
          message: `experimental_plugins.plugins: the plugin name "${definition.name}" ${problem}`,
          code: ErrorCode.CONFIGURATION_ERROR,
        });
      }
      found.push({
        id: `${definition.name}@code`,
        name: definition.name,
        origin: 'code',
        definition,
        marketplace: 'code',
      });
    }
    for (const dir of this.config.dirs ?? []) {
      try {
        const layout = await readPluginLayout(resolve(this.root, dir));
        const known =
          layout.fatal.length > 0
            ? [...this.states.values()].find(
                (state) => state.candidate.origin === 'dir' && state.candidate.dir === layout.root
              )
            : undefined;
        const name = known?.candidate.name ?? layout.manifest.name;
        const id = known?.candidate.id ?? `${name}@inline`;
        found.push({
          id,
          name,
          origin: 'dir',
          dir: layout.root,
          layout: {
            ...layout,
            diagnostics: layout.diagnostics.map((entry) => ({ ...entry, plugin: id })),
          },
          marketplace: 'inline',
        });
      } catch (error) {
        this.record({
          level: 'error',
          message: `The plugin folder ${dir} could not be read: ${message(error)}`,
          path: resolve(this.root, dir),
        });
      }
    }
    if (this.config.installed !== false) {
      const { records, warnings } = await readInstalledPlugins(this.pluginsRoot);
      for (const warning of warnings) this.record({ level: 'error', message: warning });
      for (const record of records) {
        try {
          const layout = await readPluginLayout(record.installPath, {
            ...(record.entry && { entry: record.entry }),
            fallbackName: record.name,
            id: record.id,
          });
          found.push({
            id: record.id,
            name: layout.manifest.name,
            origin: 'installed',
            dir: layout.root,
            record,
            layout,
            marketplace: record.marketplace,
          });
        } catch (error) {
          this.record({
            level: 'error',
            plugin: record.id,
            message: `The installed plugin ${record.id} could not be read from ${record.installPath}: ${message(error)}`,
          });
        }
      }
    }
    const ids = new Set<string>();
    return found.filter((candidate) => {
      if (ids.has(candidate.id)) {
        this.record({
          level: 'warning',
          plugin: candidate.id,
          message: `Not loaded: ${candidate.id} is found twice, the first one loads`,
        });
        return false;
      }
      ids.add(candidate.id);
      return true;
    });
  }

  /**
   * Brings the plugins in line with what is found and enabled now: loads the ones not loaded,
   * unloads the ones gone or switched off, and builds a new generation of the live plugins
   * `rebuild` names (`all`, `none`, or one id). Returns how each build went
   */
  private async reconcile(rebuild: string): Promise<PluginReloadResult[]> {
    const rebuilds = (id: string) => rebuild === 'all' || rebuild === id;
    this.next = new Map();
    if (this.disposed) return [];
    const candidates = await this.discover();
    this.settings = await loadPluginSettings(this.root, this.options.settings, {
      ...(this.config.enabled && { enabled: this.config.enabled }),
      ...(this.config.options && { options: this.config.options }),
    });
    for (const warning of this.settings.warnings)
      this.record({ level: 'warning', message: warning });
    const seen = new Set<string>();
    const incoming = new Map<string, Found>();
    for (const candidate of candidates) {
      seen.add(candidate.id);
      const existing = this.states.get(candidate.id);
      const found: Found = {
        candidate,
        manifest: candidate.definition ?? candidate.layout?.manifest ?? { name: candidate.name },
        format: candidate.definition ? 'code' : (candidate.layout?.format ?? 'claude'),
      };
      const state: PluginState = existing ?? {
        ...found,
        enabled: false,
        enabledBy: 'default',
        status: 'disabled',
        diagnostics: [],
        generations: 0,
        isolated: false,
      };
      if (!existing) this.states.set(candidate.id, state);
      if (!state.generation?.live) Object.assign(state, found);
      else if (rebuilds(candidate.id)) incoming.set(candidate.id, found);
      for (const diagnostic of candidate.layout?.diagnostics ?? []) this.record(diagnostic);
    }
    const gone: PluginState[] = [];
    for (const [id, state] of this.states) {
      if (state.candidate.origin === 'core' || seen.has(id)) continue;
      this.states.delete(id);
      if (state.generation) gone.push(state);
    }
    this.next = incoming;
    this.decideEnabled(candidates);
    let graph = this.resolveGraph();
    const refused = new Map<string, CogitatorError>();
    for (const id of incoming.keys()) {
      const blocked = graph.blocked.get(id);
      if (blocked && this.states.get(id)?.enabled) refused.set(id, blocked);
    }
    if (refused.size > 0) {
      for (const id of refused.keys()) incoming.delete(id);
      this.decideEnabled(candidates);
      graph = this.resolveGraph();
    }
    const off = (id: string, state: PluginState) =>
      !state.enabled || graph.blocked.has(id) || state.shadowedBy !== undefined;
    for (const id of [...graph.order].reverse()) {
      const state = this.states.get(id);
      if (state?.generation && off(id, state)) await this.unload(state);
    }
    const goneOrder = [...this.order].reverse();
    gone.sort((a, b) => goneOrder.indexOf(a.candidate.id) - goneOrder.indexOf(b.candidate.id));
    for (const state of gone) await this.unload(state);
    const results: PluginReloadResult[] = [];
    for (const id of graph.order) {
      const state = this.states.get(id);
      if (!state) continue;
      const blocked =
        graph.blocked.get(id) ??
        (state.enabled && !state.shadowedBy ? this.downDependency(state) : undefined);
      if (off(id, state) || blocked) {
        if (state.generation) await this.unload(state);
        state.status = state.enabled && !state.shadowedBy ? 'blocked' : 'disabled';
        if (state.shadowedBy !== undefined) {
          state.error = `The name "${state.manifest.name}" is taken by ${state.shadowedBy}, which takes precedence`;
          this.report(id, 'warning', `Not loaded: ${state.error}`);
        } else if (blocked) {
          state.error = blocked.message;
          this.report(id, 'error', blocked.message);
          this.emit({ type: 'blocked', plugin: id, error: blocked.message });
        } else delete state.error;
        continue;
      }
      const refusal = refused.get(id);
      if (refusal && state.generation) {
        results.push(this.refuseReload(state, refusal.message));
        continue;
      }
      if (state.generation && !rebuilds(id)) continue;
      results.push(await this.build(state, incoming.get(id)));
    }
    this.next = new Map();
    this.watch();
    this.changed();
    return results;
  }

  /** The manifest `state` loads with now: the one a rebuild found, else the one it runs with */
  private manifestOf(state: PluginState): PluginManifest {
    return this.next.get(state.candidate.id)?.manifest ?? state.manifest;
  }

  /** The result of a reload that cannot load: the live generation goes on */
  private refuseReload(state: PluginState, text: string): PluginReloadResult {
    const id = state.candidate.id;
    const generation = state.generation?.number ?? 0;
    this.report(id, 'error', `Reload failed, generation ${generation} goes on: ${text}`);
    this.emit({ type: 'reload-failed', plugin: id, generation: generation + 1, error: text });
    return { id, ok: false, generation, error: text, code: ErrorCode.PLUGIN_RELOAD_FAILED };
  }

  /**
   * The error of a dependency of `state` that has no live generation (it failed to load), which
   * keeps `state` from loading
   */
  private downDependency(state: PluginState): CogitatorError | undefined {
    for (const dependency of this.manifestOf(state).dependencies ?? []) {
      const target = this.dependencyTarget(state, dependency);
      if (!target || target.generation?.live) continue;
      return new CogitatorError({
        message: `${state.candidate.id} needs the plugin ${target.candidate.id}, which did not load${target.error ? `: ${target.error}` : ''}`,
        code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
      });
    }
    return undefined;
  }

  /**
   * Decides `enabled` of every plugin: the settings, then each one's default, then dependencies.
   * Of the enabled plugins that share a name one loads: the one managed settings enable, else the
   * first found (code, then folders, then installed). A disabled plugin shadows nothing
   */
  private decideEnabled(candidates: readonly Candidate[]): void {
    const enabled = this.settings?.enabled ?? new Map();
    for (const state of this.states.values()) {
      if (state.candidate.origin === 'core') continue;
      delete state.shadowedBy;
      const entry = enabled.get(state.candidate.id);
      if (entry) {
        state.enabled = entry.value;
        state.enabledBy = entry.layer;
      } else {
        state.enabled = this.manifestOf(state).defaultEnabled !== false;
        state.enabledBy = 'default';
      }
    }
    const shadow = () => {
      const byName = new Map<string, PluginState[]>();
      for (const candidate of candidates) {
        const state = this.states.get(candidate.id);
        if (!state?.enabled) continue;
        const group = byName.get(state.candidate.name) ?? [];
        group.push(state);
        byName.set(state.candidate.name, group);
      }
      for (const group of byName.values()) {
        const winner = group.find((state) => state.enabledBy === 'managed') ?? group[0];
        if (!winner) continue;
        for (const state of group) {
          if (state !== winner) state.shadowedBy = winner.candidate.id;
        }
      }
    };
    shadow();
    let grew = true;
    while (grew) {
      grew = false;
      for (const state of this.states.values()) {
        if (!state.enabled || state.shadowedBy !== undefined) continue;
        for (const dependency of this.manifestOf(state).dependencies ?? []) {
          const target = this.dependencyTarget(state, dependency);
          if (
            target &&
            !target.enabled &&
            target.shadowedBy === undefined &&
            !enabled.has(target.candidate.id)
          ) {
            target.enabled = true;
            target.enabledBy = 'default';
            grew = true;
          }
        }
      }
      if (grew) shadow();
    }
  }

  /**
   * The plugin `dependency` of `state` names: the one of its marketplace (the marketplace of
   * `state` when it names none), else one of that name, a local copy from code or a folder standing
   * in for any marketplace as in Claude Code
   */
  private dependencyTarget(
    state: PluginState,
    dependency: PluginDependency
  ): PluginState | undefined {
    const marketplace = dependency.marketplace ?? state.candidate.marketplace;
    const exact = this.states.get(`${dependency.name}@${marketplace}`);
    if (exact) return exact;
    const named = [...this.states.values()].filter(
      (candidate) => candidate.candidate.name === dependency.name
    );
    if (dependency.marketplace === undefined) {
      return named.find((candidate) => candidate.shadowedBy === undefined) ?? named[0];
    }
    return named.find(
      (candidate) => candidate.candidate.origin === 'dir' || candidate.candidate.origin === 'code'
    );
  }

  /**
   * The order plugins load in, dependencies first, and the ones that may not load: a cycle, or a
   * dependency missing, off, blocked or installed at a version its range does not allow (a local
   * copy, from code or a folder, is not checked against the range, as in Claude Code)
   */
  private resolveGraph(): { order: string[]; blocked: Map<string, CogitatorError> } {
    const ids = [...this.states.keys()].filter(
      (id) => this.states.get(id)?.candidate.origin !== 'core'
    );
    const edges = new Map<string, string[]>();
    const blocked = new Map<string, CogitatorError>();
    for (const id of ids) {
      const state = this.states.get(id);
      if (!state) continue;
      const targets: string[] = [];
      for (const dependency of this.manifestOf(state).dependencies ?? []) {
        const target = this.dependencyTarget(state, dependency);
        const named = `${dependency.name}${dependency.marketplace ? `@${dependency.marketplace}` : ''}`;
        if (!target) {
          if (state.enabled) {
            blocked.set(
              id,
              new CogitatorError({
                message: `${id} needs the plugin ${named}, which is not installed`,
                code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
              })
            );
          }
          continue;
        }
        targets.push(target.candidate.id);
        if (!state.enabled) continue;
        if (!target.enabled) {
          blocked.set(
            id,
            new CogitatorError({
              message: `${id} needs the plugin ${target.candidate.id}, which is disabled`,
              code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
            })
          );
        } else if (
          dependency.version !== undefined &&
          target.candidate.origin === 'installed' &&
          (this.manifestOf(target).version === undefined ||
            !satisfies(this.manifestOf(target).version ?? '', dependency.version))
        ) {
          blocked.set(
            id,
            new CogitatorError({
              message: `Requires "${target.candidate.id}" ${dependency.version}, installed ${this.manifestOf(target).version ?? 'without a version'}`,
              code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
            })
          );
        }
      }
      edges.set(id, targets);
    }
    for (const cycle of cyclesOf(ids, edges)) {
      for (const id of cycle) {
        if (this.states.get(id)?.enabled) {
          blocked.set(
            id,
            new CogitatorError({
              message: `Plugins depend on each other in a cycle: ${[...cycle, cycle[0]].join(' -> ')}`,
              code: ErrorCode.PLUGIN_DEPENDENCY_CYCLE,
            })
          );
        }
      }
    }
    const order: string[] = [];
    const placed = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (placed.has(id) || visiting.has(id)) return;
      visiting.add(id);
      for (const target of edges.get(id) ?? []) visit(target);
      visiting.delete(id);
      placed.add(id);
      order.push(id);
    };
    for (const id of ids) visit(id);
    let spread = true;
    while (spread) {
      spread = false;
      for (const id of order) {
        if (blocked.has(id) || !this.states.get(id)?.enabled) continue;
        const stuck = (edges.get(id) ?? []).find((target) => blocked.has(target));
        if (stuck) {
          blocked.set(
            id,
            new CogitatorError({
              message: `${id} needs the plugin ${stuck}, which cannot load: ${blocked.get(stuck)?.message ?? ''}`,
              code: ErrorCode.PLUGIN_DEPENDENCY_UNMET,
            })
          );
          spread = true;
        }
      }
    }
    return { order, blocked };
  }

  /**
   * Builds a new generation of `state` (as `found` now, when a live one serves) and puts it live,
   * the old one unloaded after the swap. A generation that fails leaves the live one, and what the
   * plugin was found as, as they were
   */
  private async build(state: PluginState, found?: Found): Promise<PluginReloadResult> {
    const id = state.candidate.id;
    const previous = state.generation;
    const generation = new Generation(state.generations + 1, () => this.changed());
    generation.replacing = previous?.live === true;
    const before: Found = {
      candidate: state.candidate,
      manifest: state.manifest,
      format: state.format,
    };
    if (found) Object.assign(state, found);
    try {
      await this.activate(state, generation);
      await generation.settled();
      if (generation.isDisposed) throw new Error('The plugin was unloaded while it loaded');
    } catch (error) {
      if (previous?.live) Object.assign(state, before);
      const failures = await generation.dispose();
      for (const failure of failures) {
        this.report(
          id,
          'warning',
          `A disposer (${failure.label}) failed: ${message(failure.error)}`
        );
      }
      const text = message(error);
      if (previous?.live) {
        this.report(id, 'error', `Reload failed, generation ${previous.number} goes on: ${text}`);
        this.emit({
          type: 'reload-failed',
          plugin: id,
          generation: generation.number,
          error: text,
        });
        return {
          id,
          ok: false,
          generation: previous.number,
          error: text,
          code: ErrorCode.PLUGIN_RELOAD_FAILED,
        };
      }
      state.status = 'failed';
      state.error = text;
      this.report(id, 'error', `Failed to load: ${text}`);
      this.emit({ type: 'failed', plugin: id, error: text });
      const code =
        error instanceof CogitatorError ? error.code : ErrorCode.PLUGIN_ACTIVATION_FAILED;
      return { id, ok: false, generation: 0, error: text, code };
    }
    state.generations = generation.number;
    generation.live = true;
    state.generation = generation;
    state.status = 'active';
    delete state.error;
    if (!this.order.includes(id)) this.order.push(id);
    this.changed();
    this.emit({ type: 'loaded', plugin: id, generation: generation.number });
    if (previous) await this.retire(id, previous);
    return { id, ok: true, generation: generation.number };
  }

  /**
   * Unloads a generation that no longer serves: now, or once the runs that still hold it ended
   * (`force`, on `dispose()`, does not wait for them)
   */
  private async retire(id: string, generation: Generation, force = false): Promise<void> {
    if (!force) {
      generation.live = false;
      const now = generation.retireWhenFree(() => {
        if (!this.draining.delete(generation)) return;
        void this.finishRetire(id, generation);
      });
      if (!now) this.draining.set(generation, id);
      else await this.finishRetire(id, generation);
      return;
    }
    this.draining.delete(generation);
    await this.finishRetire(id, generation);
  }

  private async finishRetire(id: string, generation: Generation): Promise<void> {
    const failures = await generation.dispose();
    for (const failure of failures) {
      this.report(id, 'warning', `A disposer (${failure.label}) failed: ${message(failure.error)}`);
    }
    this.emit({ type: 'unloaded', plugin: id, generation: generation.number });
  }

  private async unload(state: PluginState): Promise<void> {
    const generation = state.generation;
    if (!generation) return;
    delete state.generation;
    const at = this.order.indexOf(state.candidate.id);
    if (at !== -1) this.order.splice(at, 1);
    this.changed();
    await this.retire(state.candidate.id, generation);
  }

  /** The values of a plugin's options: settings, then the defaults, checked against the spec */
  private optionsOf(state: PluginState): Record<string, PluginOptionValue> {
    const spec = state.manifest.userConfig ?? {};
    const given = this.settings?.options[state.candidate.id] ?? {};
    const values: Record<string, PluginOptionValue> = {};
    for (const [key, option] of Object.entries(spec)) {
      if (option.sensitive === true) {
        if (Object.hasOwn(given, key)) {
          this.report(
            state.candidate.id,
            'warning',
            `The option ${key} is sensitive and is read from the credential store, the value in the settings is ignored`
          );
        }
        continue;
      }
      const value = Object.hasOwn(given, key) ? given[key] : option.default;
      if (value === undefined) {
        if (option.required === true) {
          this.report(
            state.candidate.id,
            'warning',
            `The option ${key} is required and not set: cogitator plugin configure ${state.candidate.id} --set ${key}=...`
          );
        }
        continue;
      }
      const problem = optionProblem(option, value);
      if (problem) {
        this.report(
          state.candidate.id,
          'warning',
          `The option ${key} ${problem}, it is left unset`
        );
        continue;
      }
      values[key] = value;
    }
    return values;
  }

  private async secretsOf(state: PluginState): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};
    for (const [key, option] of Object.entries(state.manifest.userConfig ?? {})) {
      if (option.sensitive !== true) continue;
      try {
        const value = await this.store.get(secretServiceOf(state.candidate.id), key);
        if (value !== undefined) secrets[key] = value;
        else if (option.required === true) {
          this.report(
            state.candidate.id,
            'warning',
            `The secret option ${key} is required and not set: cogitator plugin configure ${state.candidate.id} --secret ${key}`
          );
        }
      } catch (error) {
        this.report(
          state.candidate.id,
          'warning',
          `The secret option ${key} could not be read: ${message(error)}`
        );
      }
    }
    return secrets;
  }

  private variablesOf(
    state: PluginState,
    options: Record<string, PluginOptionValue>,
    secrets: Record<string, string>
  ): PluginVariables {
    return {
      ...(state.candidate.dir !== undefined && { root: state.candidate.dir }),
      data: pluginDataDir(this.pluginsRoot, state.candidate.id),
      projectDir: this.root,
      options,
      secrets,
    };
  }

  /**
   * The rules of what the plugin may do: its manifest's, only those the user granted when
   * installed, with `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` put in (a path rule that
   * starts with one becomes an absolute `//` pattern)
   */
  private permissionsOf(
    state: PluginState,
    variables: PluginVariables
  ): PluginPermissionsSpec | undefined {
    const granted = this.grantedOf(state);
    if (!granted) return undefined;
    const resolveRule = (rule: string): string => {
      const match =
        /^(Read|Edit|Write)\(\s*(\$\{(?:CLAUDE|COGITATOR)_PLUGIN_(?:ROOT|DATA)\}.*)\)$/.exec(
          rule.trim()
        );
      const text = substitute(rule, { ...variables, options: {}, secrets: {} }, 'placeholder');
      if (!match) return text;
      const inner = substitute(
        match[2] ?? '',
        { ...variables, options: {}, secrets: {} },
        'placeholder'
      );
      return `${match[1]}(/${inner.replace(/\\/g, '/')})`;
    };
    return {
      allow: (granted.allow ?? []).map(resolveRule),
      deny: (granted.deny ?? []).map(resolveRule),
    };
  }

  /**
   * The rules an installed plugin runs under: what its manifest declares, cut to what was granted.
   * A version that drops its `permissions` keeps the ones granted, so leaving the block out never
   * lifts the checks
   */
  private grantedOf(state: PluginState): PluginPermissionsSpec | undefined {
    const declared = state.manifest.permissions;
    const record = state.candidate.record;
    if (!record) return declared;
    if (!declared) {
      const kept = record.grantedPermissions;
      return kept && { allow: [...(kept.allow ?? [])], deny: [...(kept.deny ?? [])] };
    }
    const granted = new Set(record.grantedPermissions?.allow ?? []);
    const allow = (declared.allow ?? []).filter((rule) => {
      if (granted.has(rule)) return true;
      this.report(
        state.candidate.id,
        'warning',
        `The permission ${rule} was not granted when the plugin was installed, it is left out: review it with cogitator plugin update ${state.candidate.id}`
      );
      return false;
    });
    return { allow, deny: [...(declared.deny ?? []), ...(record.grantedPermissions?.deny ?? [])] };
  }

  /** Loads `state` into `generation`: its folder's components, its code, in or out of process */
  private async activate(state: PluginState, generation: Generation): Promise<void> {
    const { candidate } = state;
    if (candidate.layout?.fatal.length) {
      throw new CogitatorError({
        message: candidate.layout.fatal[0] ?? 'The manifest is not valid',
        code: ErrorCode.PLUGIN_INVALID,
      });
    }
    const engines = state.manifest.engines?.cogitator;
    const version = this.options.cogitatorVersion;
    if (engines !== undefined && version !== undefined && !satisfies(version, engines)) {
      throw new CogitatorError({
        message: `The plugin works with Cogitator ${engines}, this is ${version}`,
        code: ErrorCode.PLUGIN_INVALID,
      });
    }
    const options = this.optionsOf(state);
    const secrets = await this.secretsOf(state);
    const variables = this.variablesOf(state, options, secrets);
    if (variables.data) await mkdir(variables.data, { recursive: true, mode: 0o700 });
    const permissions = this.permissionsOf(state, variables);
    const context = this.contextOf(state, generation, variables, permissions);
    const layout = candidate.layout;
    if (layout) await this.registerLayout(state, generation, context, layout, variables);
    if (candidate.definition) {
      const returned = await candidate.definition.activate?.(context);
      if (typeof returned === 'function') generation.track(returned, 'activate');
    }
    if (layout?.main) {
      state.isolated = true;
      const isolated = await IsolatedPluginProcess.start({
        identity: {
          id: candidate.id,
          name: state.manifest.name,
          ...(state.manifest.version !== undefined && { version: state.manifest.version }),
          root: await realpath(layout.root),
          dataDir: await realpath(variables.data ?? layout.root),
        },
        entry: layout.main,
        options,
        context,
        ...(this.config.isolation && { isolation: this.config.isolation }),
        onExit: (error) => {
          void this.serial(async () => {
            if (state.generation !== generation) return;
            await this.unload(state);
            state.status = 'failed';
            state.error = error.message;
            this.report(candidate.id, 'error', error.message);
            this.emit({ type: 'failed', plugin: candidate.id, error: error.message });
          });
        },
      });
      generation.track(() => isolated.dispose(), 'process');
    }
  }

  /** Registers the components a plugin folder holds, through the plugin's own context */
  private async registerLayout(
    state: PluginState,
    generation: Generation,
    context: InternalContext,
    layout: PluginLayout,
    variables: PluginVariables
  ): Promise<void> {
    const name = state.manifest.name;
    if (layout.skillDirs.length > 0 || layout.rootSkill) {
      const loader = new PluginFolderSkills(
        name,
        layout.rootSkill ? [layout.root] : layout.skillDirs,
        variables,
        layout.rootSkill
      );
      generation.contributions.skills.push(loader);
      generation.wait(loader.discover());
      generation.track(() => {
        const at = generation.contributions.skills.indexOf(loader);
        if (at !== -1) generation.contributions.skills.splice(at, 1);
      }, 'skills');
    }
    for (const file of layout.agentFiles) {
      try {
        context.addAgent(
          agentOf(await readFile(file.path, 'utf8'), file, name, (level, text) =>
            this.report(state.candidate.id, level, text, file.path)
          )
        );
      } catch (error) {
        this.report(state.candidate.id, 'error', message(error), file.path);
      }
    }
    for (const file of layout.commandFiles) {
      const parsed = parseCommandFile(await readFile(file.path, 'utf8'), `${name}:${file.name}`, {
        path: file.path,
        source: 'plugin',
      });
      for (const diagnostic of parsed.diagnostics)
        this.record({ ...diagnostic, plugin: state.candidate.id });
      if (parsed.definition) context.addCommand(parsed.definition);
    }
    for (const inline of layout.inlineCommands) {
      context.registerCommand(inline.name, {
        template: inline.content,
        ...(inline.entry.description !== undefined && { description: inline.entry.description }),
        ...(inline.entry.argumentHint !== undefined && { argumentHint: inline.entry.argumentHint }),
        ...(inline.entry.model !== undefined && { model: inline.entry.model }),
        ...(inline.entry.allowedTools !== undefined && { allowedTools: inline.entry.allowedTools }),
      });
    }
    for (const source of layout.hooks) context.addHooks(source.hooks, source.source);
    for (const [server, config] of Object.entries(layout.mcpServers)) {
      context.addMcpServer(server, config);
    }
    for (const panel of layout.panels) context.addPanel(panel.spec, panel.path);
  }

  /** The context a plugin's generation registers through, its requests checked by `permissions` */
  private contextOf(
    state: PluginState,
    generation: Generation,
    variables: PluginVariables,
    permissions: PluginPermissionsSpec | undefined
  ): InternalContext {
    const { candidate } = state;
    const id = candidate.id;
    const pluginName = state.manifest.name;
    const set = generation.contributions;
    const logger = this.logger.child({ plugin: id });
    const checks = new PluginPermissions(
      id,
      permissions,
      this.config.permissions?.deny ?? [],
      this.root
    );
    for (const warning of checks.warnings) this.report(id, 'warning', warning);
    const fileChecks =
      candidate.origin === 'core'
        ? undefined
        : permissions !== undefined
          ? checks
          : PluginPermissions.hostDenyOnly(id, this.config.permissions?.deny ?? [], this.root);
    const codeChecks =
      permissions === undefined && candidate.layout?.main !== undefined ? checks : fileChecks;
    const capabilities = pluginCapabilities(checks, this.root, generation.signal);
    const sensitive = new Set(
      Object.entries(state.manifest.userConfig ?? {})
        .filter(([, option]) => option.sensitive === true)
        .map(([key]) => key)
    );
    const report = (level: PluginDiagnostic['level'], text: string, path?: string) =>
      this.report(id, level, text, path);
    const added = (label: string, remove: () => void): PluginDisposer => {
      generation.touch();
      return generation.track(remove, label);
    };
    const addAgent = (definition: SubagentDefinition): PluginDisposer => {
      if (set.agents.has(definition.name)) {
        throw new TypeError(`Plugin ${id} registered the agent ${definition.name} twice`);
      }
      const kept: SubagentDefinition = {
        ...definition,
        prompt: substitute(definition.prompt, variables, 'placeholder'),
        source: 'plugin',
        plugin: id,
      };
      set.agents.set(kept.name, kept);
      return added(`agent ${kept.name}`, () => {
        if (set.agents.get(kept.name) === kept) set.agents.delete(kept.name);
      });
    };
    const addCommand = (command: CommandDefinition): PluginDisposer => {
      if (set.commands.has(command.name)) {
        throw new TypeError(`Plugin ${id} registered the command ${command.name} twice`);
      }
      const kept: CommandDefinition = {
        ...command,
        template: substitute(command.template, variables, 'placeholder'),
        source: 'plugin',
        plugin: id,
      };
      set.commands.set(kept.name, kept);
      return added(`command ${kept.name}`, () => {
        if (set.commands.get(kept.name) === kept) set.commands.delete(kept.name);
      });
    };
    const addHooks = (
      hooks: HookSettings,
      source: string,
      guard: PluginPermissions | undefined
    ): PluginDisposer => {
      const allowed = this.checkedHooks(id, hooks, source, variables, guard);
      const entry = {
        plugin: id,
        hooks: allowed.hooks,
        source,
        layer: state.enabledBy === 'default' ? ('session' as const) : state.enabledBy,
        env: pluginEnvironment(variables, true),
      };
      let removed = false;
      void allowed.ready.then(() => {
        if (generation.isDisposed || removed || Object.keys(entry.hooks).length === 0) return;
        set.hooks.push(entry);
        generation.touch();
      });
      generation.wait(allowed.ready);
      return generation.track(() => {
        removed = true;
        const at = set.hooks.indexOf(entry);
        if (at !== -1) set.hooks.splice(at, 1);
      }, `hooks ${source}`);
    };
    const addPanel = (panel: PluginPanelContribution, path?: string): PluginDisposer => {
      if (!PANEL_ID.test(panel.id)) {
        throw new TypeError(`Panel id "${panel.id}" may only hold letters, digits, "-" and "_"`);
      }
      if (set.panels.has(panel.id))
        throw new TypeError(`Plugin ${id} registered the panel ${panel.id} twice`);
      let file = path;
      if (file === undefined && panel.entry !== undefined) {
        if (!candidate.dir)
          throw new TypeError(`Panel ${panel.id}: a plugin in code gives its page as html`);
        const resolved = resolve(candidate.dir, panel.entry);
        if (!isInside(candidate.dir, resolved)) {
          throw new TypeError(`Panel ${panel.id}: ${panel.entry} is outside the plugin`);
        }
        file = resolved;
      }
      if (file === undefined && panel.html === undefined) {
        throw new TypeError(`Panel ${panel.id} needs an entry file or html`);
      }
      const { handlers, html, ...spec } = panel;
      const entry: PluginPanelEntry = {
        plugin: id,
        panel: spec,
        ...(file !== undefined && { path: file }),
        ...(html !== undefined && { html }),
        handlers: handlers ?? {},
      };
      set.panels.set(panel.id, entry);
      return added(`panel ${panel.id}`, () => {
        if (set.panels.get(panel.id) === entry) set.panels.delete(panel.id);
      });
    };
    const context: InternalContext = {
      plugin: {
        id,
        name: pluginName,
        ...(state.manifest.version !== undefined && { version: state.manifest.version }),
        ...(candidate.dir !== undefined && { root: candidate.dir }),
        ...(variables.data !== undefined && { dataDir: variables.data }),
        isolated: candidate.layout?.main !== undefined,
      },
      options: Object.freeze({ ...variables.options }),
      secret: async (key) => {
        if (!sensitive.has(key)) {
          throw new CogitatorError({
            message: `Plugin ${id} declares no sensitive option ${key}`,
            code: ErrorCode.VALIDATION_ERROR,
          });
        }
        if (Object.hasOwn(variables.secrets, key)) return variables.secrets[key];
        return this.store.get(secretServiceOf(id), key);
      },
      logger: {
        debug: (text, details) => logger.debug(text, details),
        info: (text, details) => logger.info(text, details),
        warn: (text, details) => logger.warn(text, details),
        error: (text, details) => logger.error(text, details),
      },
      signal: generation.signal,
      files: capabilities.files,
      fetch: capabilities.fetch,
      exec: capabilities.exec,
      registerTool: (tool: Tool | PluginToolSpec) => {
        const built = isBuiltTool(tool) ? tool : toolFromSpec(tool);
        if (set.tools.has(built.name)) {
          throw new TypeError(`Plugin ${id} registered the tool ${built.name} twice`);
        }
        set.tools.set(built.name, built);
        return added(`tool ${built.name}`, () => {
          if (set.tools.get(built.name) === built) set.tools.delete(built.name);
        });
      },
      registerSkill: (skill: PluginSkillSpec) => {
        if (!PLUGIN_SKILL_NAME.test(skill.name)) {
          throw new TypeError(
            `Skill "${skill.name}": a name may only hold lowercase letters, digits and hyphens`
          );
        }
        set.codeSkills ??= new PluginCodeSkills(pluginName);
        const remove = set.codeSkills.add({
          ...skill,
          instructions: substitute(skill.instructions, variables, 'placeholder'),
        });
        return added(`skill ${skill.name}`, remove);
      },
      registerAgent: (agentName: string, input: SubagentDefinitionInput) => {
        const full = `${pluginName}:${agentName}`;
        const problem = componentNameProblem(agentName);
        if (problem) throw new TypeError(`Agent "${agentName}" of plugin ${id} ${problem}`);
        if (typeof input.description !== 'string' || input.description.trim() === '') {
          throw new TypeError(`Agent "${agentName}" of plugin ${id} needs a description`);
        }
        const definition = withoutPluginIgnored(
          { ...input, name: full, prompt: input.prompt ?? '', source: 'plugin' },
          (text) => report('warning', `Agent ${full}: ${text}`)
        );
        return addAgent(definition);
      },
      registerCommand: (commandName: string, command: string | CommandDefinitionInput) => {
        if (!COMMAND_NAME.test(commandName) || commandName.endsWith(':')) {
          throw new TypeError(`"${commandName}" cannot name a command of plugin ${id}`);
        }
        const input = typeof command === 'string' ? { template: command } : command;
        return addCommand({ ...input, name: `${pluginName}:${commandName}`, source: 'plugin' });
      },
      registerHooks: (hooks: HookSettings) => addHooks(hooks, 'code', codeChecks),
      registerMcpServer: (server: string, config: PluginMcpServerConfig) =>
        this.addMcpServer(state, generation, server, config, variables, codeChecks),
      registerLLMBackend: (plugin: LLMPlugin) => {
        if (
          typeof plugin.provider !== 'string' ||
          plugin.provider === '' ||
          plugin.provider.includes('/')
        ) {
          throw new TypeError(`Plugin ${id}: an LLM provider needs a name without "/"`);
        }
        if (set.backends.has(plugin.provider)) {
          throw new TypeError(`Plugin ${id} registered the LLM provider ${plugin.provider} twice`);
        }
        set.backends.set(plugin.provider, plugin);
        return added(`backend ${plugin.provider}`, () => {
          if (set.backends.get(plugin.provider) === plugin) set.backends.delete(plugin.provider);
        });
      },
      registerMiddleware: (middleware: RunMiddleware) => {
        set.middleware.push(middleware);
        return added(`middleware ${middleware.name}`, () => {
          const at = set.middleware.indexOf(middleware);
          if (at !== -1) set.middleware.splice(at, 1);
        });
      },
      registerPanel: (panel: PluginPanelContribution) => addPanel(panel),
      onDispose: (dispose: PluginDisposer) => generation.track(dispose, 'onDispose'),
      addAgent,
      addCommand,
      addHooks: (hooks: HookSettings, source: string) => addHooks(hooks, source, fileChecks),
      addMcpServer: (server: string, config: PluginMcpServerConfig) =>
        this.addMcpServer(state, generation, server, config, variables, fileChecks),
      addPanel,
    };
    return context;
  }

  /**
   * The hooks of a plugin as they will run: `${CLAUDE_PLUGIN_ROOT}` and the plugin's options put
   * into commands (an exec-form hook gets secrets in its arguments, a shell-form hook that names an
   * option is refused), and, for a plugin with `permissions`, every command and URL checked
   * against them. A handler that may not run is left out with a diagnostic
   */
  private checkedHooks(
    id: string,
    hooks: HookSettings,
    source: string,
    variables: PluginVariables,
    checks: PluginPermissions | undefined
  ): { hooks: HookSettings; ready: Promise<void> } {
    const warnings: string[] = [];
    const loaded = readHookSettings(hooks, 'session', source, warnings);
    for (const warning of warnings) this.report(id, 'warning', warning, source);
    const settings: Partial<Record<HookEventName, HookMatcherGroup[]>> = {};
    const checksDone: Promise<void>[] = [];
    for (const hook of loaded) {
      let handler = hook.handler;
      if (handler.type === 'command') {
        if (handler.args === undefined && referencesOptions(handler.command)) {
          this.report(
            id,
            'error',
            `A shell-form hook command cannot take \${user_config.*}, use args or CLAUDE_PLUGIN_OPTION_<KEY>: the hook is skipped`,
            source
          );
          continue;
        }
        handler = {
          ...handler,
          command: substitute(
            handler.command,
            variables,
            handler.args === undefined ? 'refuse' : 'value'
          ),
          ...(handler.args !== undefined && {
            args: handler.args.map((arg) => substitute(arg, variables, 'value')),
          }),
        };
      } else if (handler.type === 'http') {
        handler = { ...handler, url: substitute(handler.url, variables, 'value') };
      }
      const group = (settings[hook.event] ??= []);
      const target = group.find((candidate) => candidate.matcher === hook.matcher) ?? {
        ...(hook.matcher !== undefined && { matcher: hook.matcher }),
        hooks: [],
      };
      if (!group.includes(target)) group.push(target);
      const final = handler;
      if (checks && (final.type === 'command' || final.type === 'http')) {
        checksDone.push(
          (async () => {
            const shown =
              final.type === 'command'
                ? commandText(
                    substitute(
                      hook.handler.type === 'command' ? hook.handler.command : '',
                      variables,
                      'placeholder'
                    ),
                    hook.handler.type === 'command'
                      ? hook.handler.args?.map((arg) => substitute(arg, variables, 'placeholder'))
                      : undefined
                  )
                : substitute(
                    hook.handler.type === 'http' ? hook.handler.url : '',
                    variables,
                    'placeholder'
                  );
            const decision = await checks.decide(
              final.type === 'command'
                ? { kind: 'command', command: shown }
                : { kind: 'fetch', url: final.url }
            );
            if (decision.allowed) {
              target.hooks = [...target.hooks, final];
              return;
            }
            this.report(
              id,
              'error',
              `The plugin's permissions do not allow its ${hook.event} hook ${shown}: the hook is skipped (${decision.reason})`,
              source
            );
          })()
        );
      } else {
        target.hooks = [...target.hooks, final];
      }
    }
    return {
      hooks: settings,
      ready: Promise.all(checksDone).then(() => {
        for (const event of Object.keys(settings) as HookEventName[]) {
          const groups = (settings[event] ?? []).filter((group) => group.hooks.length > 0);
          if (groups.length === 0) delete settings[event];
          else settings[event] = groups;
        }
      }),
    };
  }

  private addMcpServer(
    state: PluginState,
    generation: Generation,
    server: string,
    config: PluginMcpServerConfig,
    variables: PluginVariables,
    checks: PluginPermissions | undefined
  ): PluginDisposer {
    const id = state.candidate.id;
    const full = `plugin:${state.manifest.name}:${server}`;
    const set = generation.contributions;
    if (set.mcpServers.has(full))
      throw new TypeError(`Plugin ${id} registered the MCP server ${server} twice`);
    set.mcpServers.add(full);
    const resolved = substituteServer(config, variables);
    const connector = this.config.mcp;
    let close: (() => Promise<void>) | undefined;
    let removed = false;
    const tools: Tool[] = [];
    const connect = async () => {
      if (checks) {
        const env =
          typeof config.env === 'object' && config.env !== null ? Object.keys(config.env) : [];
        const loader =
          typeof resolved.url === 'string' || checks.scope !== 'granted'
            ? undefined
            : loaderVariableOf(env);
        const decision = loader
          ? {
              allowed: false,
              reason: `it sets ${loader}, which changes what the command loads`,
            }
          : typeof resolved.url === 'string'
            ? await checks.decide({ kind: 'fetch', url: resolved.url })
            : await checks.decide({
                kind: 'command',
                command: commandText(
                  substitute(String(config.command ?? ''), variables, 'placeholder'),
                  Array.isArray(config.args)
                    ? config.args.map((arg) => substitute(String(arg), variables, 'placeholder'))
                    : undefined
                ),
                ...(typeof resolved.cwd === 'string' && {
                  cwd: resolve(this.root, resolved.cwd),
                }),
              });
        if (!decision.allowed) {
          this.report(
            id,
            'error',
            `The plugin's permissions do not allow its MCP server ${server}: it is not started (${decision.reason})`
          );
          return;
        }
      }
      if (!connector) {
        this.report(
          id,
          'warning',
          `The MCP server ${full} needs experimental_plugins.mcp to connect (experimental_mcpConnector() of @cogitator-ai/mcp): it is skipped`
        );
        return;
      }
      try {
        const connection = await connector([{ name: full, config: resolved }], {
          agent: id,
          signal: generation.signal,
        });
        if (generation.isDisposed || removed) {
          await connection.close();
          return;
        }
        close = () => connection.close();
        for (const tool of connection.tools) {
          if (set.tools.has(tool.name)) {
            this.report(
              id,
              'warning',
              `The MCP tool ${tool.name} has the name of another tool of the plugin, it is left out`
            );
            continue;
          }
          set.tools.set(tool.name, tool);
          tools.push(tool);
        }
        generation.touch();
      } catch (error) {
        const text = `The MCP server ${full} did not start: ${message(error)}`;
        if (generation.replacing && !removed) {
          throw new CogitatorError({ message: text, code: ErrorCode.PLUGIN_ACTIVATION_FAILED });
        }
        this.report(id, 'error', text);
      }
    };
    generation.wait(connect(), true);
    return generation.track(async () => {
      removed = true;
      set.mcpServers.delete(full);
      for (const tool of tools) if (set.tools.get(tool.name) === tool) set.tools.delete(tool.name);
      await close?.();
    }, `mcp ${full}`);
  }

  private infoOf(state: PluginState): PluginInfo {
    const set = state.generation?.contributions;
    const contributions: PluginContributions = {
      tools: set ? [...set.tools.keys()] : [],
      skills: set
        ? [
            ...set.skills.flatMap((loader) =>
              loader instanceof PluginFolderSkills ? loader.names() : []
            ),
            ...(set.codeSkills ? set.codeSkills.names() : []),
          ]
        : [],
      agents: set ? [...set.agents.keys()] : [],
      commands: set ? [...set.commands.keys()] : [],
      hooks: set
        ? set.hooks.reduce(
            (count, entry) =>
              count +
              Object.values(entry.hooks).reduce(
                (sum, groups) =>
                  sum + (groups ?? []).reduce((all, group) => all + group.hooks.length, 0),
                0
              ),
            0
          )
        : 0,
      mcpServers: set ? [...set.mcpServers] : [],
      llmBackends: set ? [...set.backends.keys()] : [],
      middleware: set?.middleware.length ?? 0,
      panels: set ? [...set.panels.values()].map((entry) => entry.panel) : [],
    };
    const { manifest, candidate } = state;
    return {
      id: candidate.id,
      name: manifest.name,
      ...(manifest.displayName !== undefined && { displayName: manifest.displayName }),
      ...(manifest.version !== undefined && { version: manifest.version }),
      ...(manifest.description !== undefined && { description: manifest.description }),
      origin: candidate.origin,
      format: state.format,
      ...(candidate.dir !== undefined && { root: candidate.dir }),
      dataDir: pluginDataDir(this.pluginsRoot, candidate.id),
      enabled: state.enabled,
      enabledBy: state.enabledBy,
      status: state.status,
      ...(state.error !== undefined && { error: state.error }),
      generation: state.generation?.number ?? 0,
      isolated: state.isolated,
      dependencies: manifest.dependencies ?? [],
      ...(manifest.permissions && { permissions: manifest.permissions }),
      ...(manifest.userConfig && { userConfig: manifest.userConfig }),
      contributions,
      diagnostics: [...state.diagnostics],
    };
  }

  /** Watches the folders of the live folder plugins, with `watch` on */
  private watch(): void {
    const setting = this.config.watch;
    if (!setting || this.disposed) return;
    const debounce =
      typeof setting === 'object'
        ? (setting.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS)
        : DEFAULT_WATCH_DEBOUNCE_MS;
    const wanted = new Map<string, string>();
    for (const state of this.states.values()) {
      if (state.candidate.dir && state.status !== 'disabled')
        wanted.set(state.candidate.id, state.candidate.dir);
    }
    for (const [id, watcher] of this.watchers) {
      if (!wanted.has(id)) {
        watcher.close();
        this.watchers.delete(id);
      }
    }
    for (const [id, dir] of wanted) {
      if (this.watchers.has(id)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, file) => {
          if (typeof file === 'string' && ignoredByWatch(file)) return;
          clearTimeout(this.watchTimers.get(id));
          this.watchTimers.set(
            id,
            setTimeout(() => {
              this.watchTimers.delete(id);
              void this.reload(id).catch((error: unknown) =>
                this.report(id, 'error', `Reload after a change failed: ${message(error)}`)
              );
            }, debounce)
          );
        });
        watcher.on('error', (error) => {
          watcher.close();
          if (this.watchers.get(id) === watcher) this.watchers.delete(id);
          this.report(
            id,
            'warning',
            `The plugin folder stopped being watched (${message(error)}), the next reload watches it again`
          );
        });
        this.watchers.set(id, watcher);
      } catch (error) {
        this.report(id, 'warning', `The plugin folder cannot be watched: ${message(error)}`);
      }
    }
  }
}

/** The context the host's own loaders register a folder's components through */
interface InternalContext extends PluginContext {
  addAgent(definition: SubagentDefinition): PluginDisposer;
  addCommand(command: CommandDefinition): PluginDisposer;
  /** Adds hooks from the plugin's files: checked like `registerHooks` of a plugin without code */
  addHooks(hooks: HookSettings, source: string): PluginDisposer;
  /** Adds an MCP server from the plugin's files, checked like its hooks files */
  addMcpServer(server: string, config: PluginMcpServerConfig): PluginDisposer;
  addPanel(panel: PluginPanelContribution, path?: string): PluginDisposer;
}

/** Whether a change to `file` (relative to a plugin folder) is one a reload ignores */
function ignoredByWatch(file: string): boolean {
  return file.split(/[\\/]/).some((part) => part === 'node_modules' || part === '.git');
}

/** Why `name` cannot name a component of a plugin, its parts separated by `:` */
function componentNameProblem(name: string): string | undefined {
  if (name === '') return 'is empty';
  if (name.length > 256) return 'is longer than 256 characters';
  if (!name.split(':').every((part) => COMPONENT_SEGMENT.test(part))) {
    return 'may only hold lowercase letters, digits and hyphens, with ":" between parts';
  }
  return undefined;
}

/**
 * A subagent of a plugin without the fields Claude Code ignores for plugin agents
 * (`permissionMode`, `hooks`, `mcpServers`): an agent a plugin brings cannot widen the mode of
 * the run or start processes of its own
 */
function withoutPluginIgnored(
  definition: SubagentDefinition,
  warn: (text: string) => void
): SubagentDefinition {
  const { permissionMode, hooks, mcpServers, ...kept } = definition;
  if (permissionMode !== undefined) warn('permissionMode is ignored for an agent of a plugin');
  if (hooks !== undefined)
    warn("hooks are ignored for an agent of a plugin, add them as the plugin's hooks");
  if (mcpServers !== undefined) {
    warn("mcpServers are ignored for an agent of a plugin, add them as the plugin's MCP servers");
  }
  return kept;
}

/**
 * The subagent of a plugin's agent file, named `plugin:folders:name` as Claude Code names it: the
 * frontmatter `name` replaces the file's name. A file whose frontmatter does not parse, or that
 * names nothing or describes nothing, still loads, named after the file, as in Claude Code
 */
function agentOf(
  text: string,
  file: { path: string; name: string },
  plugin: string,
  report: (level: PluginDiagnostic['level'], text: string) => void
): SubagentDefinition {
  const parts = file.name.split(':');
  const read = readFrontmatter(text);
  const fields = 'error' in read ? {} : read.fields;
  const declared =
    typeof fields.name === 'string' && fields.name.trim() !== '' && fields.name.trim().length <= 256
      ? fields.name.trim()
      : undefined;
  if (declared !== undefined) parts[parts.length - 1] = declared;
  const problem = componentNameProblem(parts.join(':'));
  const full = `${plugin}:${parts.join(':')}`;
  if (problem) throw new Error(`The agent ${full} ${problem}, it is skipped`);
  const fallback = `Agent from ${plugin} plugin`;
  if ('error' in read) {
    if (read.error !== 'missing')
      report('warning', `${read.error}, every field of the agent is ignored`);
    return {
      name: full,
      description: fallback,
      prompt: text.trim(),
      source: 'plugin',
      path: file.path,
    };
  }
  const description =
    typeof fields.description === 'string' && fields.description.trim() !== ''
      ? fields.description
      : fallback;
  const normalized = `---\n${stringifyYaml({ ...fields, name: parts[parts.length - 1], description })}---\n${read.body}`;
  const parsed = parseSubagentFile(normalized, { path: file.path, source: 'plugin' });
  for (const diagnostic of parsed.diagnostics)
    report(diagnostic.level === 'error' ? 'warning' : diagnostic.level, diagnostic.message);
  if (!parsed.definition) {
    return { name: full, description, prompt: read.body.trim(), source: 'plugin', path: file.path };
  }
  return withoutPluginIgnored(
    { ...parsed.definition, name: full, source: 'plugin', path: file.path },
    (warning) => report('warning', warning)
  );
}

/** A command line for a permission check: the exec form's arguments quoted where they need it */
function commandText(command: string, args: readonly string[] | undefined): string {
  if (args === undefined) return command;
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`
    )
    .join(' ');
}

/** Why `value` does not fit `option`, undefined when it does */
function optionProblem(option: PluginOptionSpec, value: PluginOptionValue): string | undefined {
  switch (option.type) {
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) return 'is not a number';
      if (option.min !== undefined && value < option.min) return `is below ${option.min}`;
      if (option.max !== undefined && value > option.max) return `is above ${option.max}`;
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'is not true or false';
    default:
      if (option.multiple === true) {
        return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
          ? undefined
          : 'is not a list of strings';
      }
      if (typeof value !== 'string') return 'is not a string';
      if (option.required === true && value === '') return 'is empty';
      if (option.options && !option.options.includes(value)) {
        return `is not one of ${option.options.join(', ')}`;
      }
      return undefined;
  }
}

/** The cycles among `ids`, each as the ids in it */
function cyclesOf(
  ids: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>
): string[][] {
  let index = 0;
  const indexes = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const connect = (id: string) => {
    indexes.set(id, index);
    low.set(id, index);
    index++;
    stack.push(id);
    onStack.add(id);
    for (const target of edges.get(id) ?? []) {
      if (!indexes.has(target)) {
        connect(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, indexes.get(target) ?? 0));
      }
    }
    if (low.get(id) === indexes.get(id)) {
      const component: string[] = [];
      for (;;) {
        const top = stack.pop();
        if (top === undefined) break;
        onStack.delete(top);
        component.push(top);
        if (top === id) break;
      }
      const selfLoop = component.length === 1 && (edges.get(id) ?? []).includes(id);
      if (component.length > 1 || selfLoop) cycles.push(component.reverse());
    }
  };
  for (const id of ids) if (!indexes.has(id)) connect(id);
  return cycles;
}
