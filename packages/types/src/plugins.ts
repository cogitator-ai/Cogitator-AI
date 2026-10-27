/**
 * Plugins, experimental: packages of tools, skills, subagents, hooks, MCP servers, commands, LLM
 * backends, Studio panels and settings, in the format of Claude Code's plugins
 * (`.claude-plugin/plugin.json`) with a Cogitator extension (`.cogitator-plugin/plugin.json`).
 * Every entry point is named `experimental_` and listed in `docs/EXPERIMENTAL_API.md`: the shapes
 * here may still change in a minor release
 */

import type { HookSettings, HookSettingsOptions } from './hooks';
import type { LLMBackend } from './llm';
import type { RunMiddleware } from './middleware';
import type { PermissionLayer } from './permissions';
import type {
  CommandDefinitionInput,
  SubagentDefinitionInput,
  SubagentMcpConnector,
} from './subagents';
import type { Tool } from './tool';

/**
 * Undoes one registration: a tool, a skill, a hook set, a server. A plugin's registrations are
 * undone in reverse order when it unloads, a disposer that throws does not keep the others from
 * running
 */
export type PluginDisposer = () => void | Promise<void>;

/** A value of a plugin option, as `userConfig` declares one */
export type PluginOptionValue = string | number | boolean | readonly string[];

/**
 * An option a plugin asks the user for, Claude Code's `userConfig` entry. A `sensitive` one is a
 * secret: it is kept in the operating system's credential store, never in a settings file, and
 * never put into skill, agent or command text
 */
export interface PluginOptionSpec {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  /** Label of the field */
  title: string;
  /** Help text under the field */
  description: string;
  /** An empty value is not accepted */
  required?: boolean;
  /** The value used while the user gave none */
  default?: PluginOptionValue;
  /** For a `string` that is neither `multiple` nor `sensitive`: the values it accepts */
  options?: readonly string[];
  /** For a `string`: a list of strings */
  multiple?: boolean;
  /** A secret: masked, kept in the credential store */
  sensitive?: boolean;
  /** Bounds of a `number` */
  min?: number;
  max?: number;
}

/**
 * A plugin another one needs enabled: `"name"`, `"name@marketplace"`, or with a semver range
 * (`~2.1.0`, `^2.0`, `>=1.4`) its version must satisfy. A bare name is looked up in the
 * declaring plugin's own marketplace
 */
export interface PluginDependency {
  name: string;
  marketplace?: string;
  version?: string;
}

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/** A command of the manifest's `commands` map: a Markdown file or inline content */
export interface PluginCommandEntry {
  source?: string;
  content?: string;
  description?: string;
  argumentHint?: string;
  model?: string;
  allowedTools?: readonly string[];
}

/** An MCP server, as `.mcp.json` writes one: a command over stdio, or an HTTP or SSE URL */
export type PluginMcpServerConfig = Readonly<Record<string, unknown>>;

/**
 * A page a plugin adds to Studio, shown in a sandboxed frame: `entry` is an HTML file of the
 * plugin (`./ui/panel.html`), or `html` the page itself for one defined in code. The page talks to
 * the plugin through `window.parent.postMessage({ type: 'cogitator:request', id, method, params })`
 * and gets `{ type: 'cogitator:response', id, result | error }`: `method` names one of the panel's
 * `handlers`
 */
export interface PluginPanelSpec {
  /** Unique within the plugin: letters, digits, `-` and `_` */
  id: string;
  title: string;
  description?: string;
  /** Name of an icon (Lucide names by convention) */
  icon?: string;
  /** The HTML file, relative to the plugin root and starting with `./` */
  entry?: string;
}

/** What a plugin adds to user interfaces such as Studio */
export interface PluginUISpec {
  panels?: readonly PluginPanelSpec[];
}

/**
 * What a plugin may do beyond its own folder, as permission rules in Claude Code's grammar:
 * `Read(./docs/**)` and `Edit(./out/**)` for files (relative to the project root), `Bash(git
 * status *)` for commands, `WebFetch(domain:api.example.com)` for requests. A request no `allow`
 * rule covers is refused, a `deny` rule refuses what an `allow` rule would let through. The
 * permission engine decides, as for the tool calls of a run
 */
export interface PluginPermissionsSpec {
  allow?: readonly string[];
  deny?: readonly string[];
}

/** One path, or several, relative to the plugin root and starting with `./` */
export type PluginPaths = string | readonly string[];

/**
 * A plugin's manifest as Cogitator reads it: Claude Code's `.claude-plugin/plugin.json` (or the
 * marketplace entry that stands in for it), with `.cogitator-plugin/plugin.json` over it field by
 * field. Paths start with `./` and stay inside the plugin
 */
export interface PluginManifest {
  /** kebab-case, without spaces, `@`, `:` or path separators: every component is named `name:...` */
  name: string;
  displayName?: string;
  /** Pins the installed version until it changes. Not checked against semver */
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: readonly string[];
  /** Whether it is enabled while no `enabledPlugins` entry names it (default true) */
  defaultEnabled?: boolean;
  dependencies?: readonly PluginDependency[];
  userConfig?: Readonly<Record<string, PluginOptionSpec>>;
  /** Claude Code's plugin defaults: only `agent`, the subagent the main thread runs as, is read */
  settings?: { agent?: string };
  /** Directories of skills, on top of `skills/` */
  skills?: PluginPaths;
  /** Command files or directories instead of `commands/`, or a map of commands */
  commands?: PluginPaths | Readonly<Record<string, PluginCommandEntry>>;
  /** Agent files instead of `agents/` */
  agents?: PluginPaths;
  /** Hook files (`{ "hooks": {...} }`) or inline hooks, on top of `hooks/hooks.json` */
  hooks?: string | HookSettings | readonly (string | HookSettings)[];
  /** `.mcp.json` style files or inline servers, on top of `.mcp.json` */
  mcpServers?:
    | string
    | Readonly<Record<string, PluginMcpServerConfig>>
    | readonly (string | Readonly<Record<string, PluginMcpServerConfig>>)[];
  /** Cogitator: an ES module whose default export is a plugin definition (`experimental_definePlugin`) */
  main?: string;
  /** Cogitator: Studio panels */
  ui?: PluginUISpec;
  /** Cogitator: what the plugin may do beyond its folder */
  permissions?: PluginPermissionsSpec;
  /** Cogitator: the versions of Cogitator it works with, as semver ranges */
  engines?: { cogitator?: string };
}

/** Something found wrong with a plugin: `error` kept it (or one of its parts) from loading */
export interface PluginDiagnostic {
  readonly level: 'error' | 'warning';
  readonly message: string;
  /** The plugin's id */
  readonly plugin?: string;
  /** The file it is about */
  readonly path?: string;
}

/** A tool of a plugin given by a JSON Schema, which crosses a process boundary as data */
export interface PluginToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments, an object schema */
  parameters: Readonly<Record<string, unknown>>;
  /** Whether a call needs approval before it runs */
  requiresApproval?: boolean;
  /** The tool only reads: plan mode may run it */
  readOnly?: boolean;
  /** Milliseconds a call may take */
  timeout?: number;
  execute(args: Record<string, unknown>, context: PluginToolCallContext): Promise<unknown>;
}

/** What a plugin tool's call gets besides its arguments */
export interface PluginToolCallContext {
  /** Aborts when the call is cancelled */
  signal: AbortSignal;
  runId?: string;
  toolCallId?: string;
  threadId?: string;
}

/** A skill a plugin defines in code, as the parts of a `SKILL.md` folder */
export interface PluginSkillSpec {
  /** kebab-case, the skill is named `plugin:name` */
  name: string;
  /** When to use it: the model picks skills by it */
  description: string;
  /** The body of `SKILL.md` */
  instructions: string;
  /** Other files of the skill folder, by path relative to it */
  files?: Readonly<Record<string, string>>;
  /** Permission rules pre-approved while the skill is active, as `allowed-tools` */
  allowedTools?: readonly string[];
}

/** An LLM backend a plugin provides, for models named `provider/model` */
export interface LLMPluginMetadata {
  name: string;
  version?: string;
  description?: string;
  author?: string;
}

/** Builds a backend from the configuration of `llm.plugins[provider]` */
export type LLMBackendFactory<TConfig = unknown> = (config: TConfig) => LLMBackend;

/**
 * A provider of LLM backends, the kind of plugin Cogitator had before plugins: `registerLLMBackend`
 * makes it known to every runtime of the process, `PluginContext.registerLLMBackend` to one
 */
export interface LLMPlugin<TConfig = unknown> {
  metadata: LLMPluginMetadata;
  provider: string;
  factory: LLMBackendFactory<TConfig>;
  validateConfig?: (config: unknown) => config is TConfig;
}

/** A panel a plugin defines in code, with the requests its page may make */
export interface PluginPanelContribution extends PluginPanelSpec {
  /** The page itself, instead of `entry` */
  html?: string;
  /** What the page may ask for, by method name: each gets the request's `params` */
  handlers?: Readonly<Record<string, (params: unknown) => unknown>>;
}

/** What `PluginContext.fetch` returns: the response read in full */
export interface PluginFetchResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** The body as text, decoded as UTF-8 */
  text: string;
}

/** How a command run through `PluginContext.exec` ended */
export interface PluginExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Files beyond the plugin's folder, read and written by the host after its `permissions` allow
 * the path (`Read(...)`, `Edit(...)`). Relative paths start from the project root
 */
export interface PluginFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<{ name: string; type: 'file' | 'directory' | 'other' }[]>;
}

/** Where a plugin writes its own messages: the runtime's logger, tagged with the plugin */
export interface PluginLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** The plugin a context belongs to */
export interface PluginIdentity {
  /** `name@marketplace`, `name@inline` for a folder of the host, `name@code` for one in code */
  id: string;
  name: string;
  version?: string;
  /** The plugin's folder, unset for one in code */
  root?: string;
  /** Its own folder that lasts across updates, `${CLAUDE_PLUGIN_DATA}` */
  dataDir?: string;
  /** Whether it runs in a process of its own */
  isolated: boolean;
}

/**
 * What a plugin's `activate` gets: one API for the plugins of the core, of the host's code and of
 * third parties, in the process or out of it. Every registration returns its disposer, and the
 * plugin's are undone in reverse order when it unloads. What the plugin does beyond its folder
 * (`files`, `fetch`, `exec`) is checked against its `permissions`, whoever wrote it
 */
export interface PluginContext {
  readonly plugin: PluginIdentity;
  /** The values of its options that are not secrets, defaults filled in */
  readonly options: Readonly<Record<string, PluginOptionValue>>;
  /** Reads a `sensitive` option from the credential store, undefined while it is not set */
  secret(key: string): Promise<string | undefined>;
  readonly logger: PluginLogger;
  /** Aborts when the plugin unloads */
  readonly signal: AbortSignal;
  readonly files: PluginFiles;
  fetch(
    url: string,
    init?: { method?: string; headers?: Readonly<Record<string, string>>; body?: string }
  ): Promise<PluginFetchResponse>;
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<PluginExecResult>;
  /** A tool every agent of the runtime gets: a spec with a JSON Schema, or a `tool()` */
  registerTool(tool: PluginToolSpec): PluginDisposer;
  registerTool(tool: Tool): PluginDisposer;
  /** A skill every agent of the runtime may activate, named `plugin:name` */
  registerSkill(skill: PluginSkillSpec): PluginDisposer;
  /** A subagent runs may delegate to, named `plugin:name` */
  registerAgent(name: string, definition: SubagentDefinitionInput): PluginDisposer;
  /** A command run inputs may name, `/plugin:name` */
  registerCommand(name: string, command: string | CommandDefinitionInput): PluginDisposer;
  /** Hooks in the format of a settings file's `hooks` */
  registerHooks(hooks: HookSettings): PluginDisposer;
  /** An MCP server, named `plugin:<plugin>:<name>`, its tools `mcp__plugin_<plugin>_<name>__<tool>` */
  registerMcpServer(name: string, config: PluginMcpServerConfig): PluginDisposer;
  /** A provider of LLM backends: agents with models `provider/model` run on it */
  registerLLMBackend(plugin: LLMPlugin): PluginDisposer;
  /** A run middleware of every run, after the runtime's own. Only in the host's process */
  registerMiddleware(middleware: RunMiddleware): PluginDisposer;
  /** A Studio panel */
  registerPanel(panel: PluginPanelContribution): PluginDisposer;
  /** Runs `dispose` when the plugin unloads, in reverse order with its registrations */
  onDispose(dispose: PluginDisposer): PluginDisposer;
}

/**
 * A plugin in code: its manifest fields and `activate`, which registers what it adds. What
 * `activate` returns is undone first when the plugin unloads
 */
export interface PluginDefinition extends Omit<PluginManifest, 'main'> {
  activate?(context: PluginContext): void | PluginDisposer | Promise<void | PluginDisposer>;
}

/** Where a plugin was found */
export type PluginOrigin = 'core' | 'code' | 'dir' | 'installed';

/**
 * Whether it works: `active` (its generation is loaded), `disabled` (switched off by settings),
 * `blocked` (a dependency is missing, off, of a wrong version or in a cycle), `failed` (it did not
 * load, see `error`), `unloaded` (the host was disposed)
 */
export type PluginStatus = 'active' | 'disabled' | 'blocked' | 'failed' | 'unloaded';

/** What a loaded plugin added, by kind */
export interface PluginContributions {
  tools: readonly string[];
  skills: readonly string[];
  agents: readonly string[];
  commands: readonly string[];
  /** Hook handlers, counted */
  hooks: number;
  mcpServers: readonly string[];
  llmBackends: readonly string[];
  /** Middleware, counted */
  middleware: number;
  panels: readonly PluginPanelSpec[];
}

/** A plugin as the host knows it */
export interface PluginInfo {
  id: string;
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  origin: PluginOrigin;
  /** The manifest's format: Claude Code's, Cogitator's extension over it, or code */
  format: 'claude' | 'cogitator' | 'code';
  root?: string;
  dataDir?: string;
  enabled: boolean;
  /** What decided `enabled`: a settings layer, or the plugin's `defaultEnabled` */
  enabledBy: PermissionLayer | 'default';
  status: PluginStatus;
  /** Why it failed or is blocked */
  error?: string;
  /** How many times it loaded: a reload that fails keeps the generation that works */
  generation: number;
  isolated: boolean;
  dependencies: readonly PluginDependency[];
  permissions?: PluginPermissionsSpec;
  userConfig?: Readonly<Record<string, PluginOptionSpec>>;
  contributions: PluginContributions;
  diagnostics: readonly PluginDiagnostic[];
}

/** Something the plugin host did, as `PluginsConfig.onEvent` hears it */
export type PluginHostEvent =
  | { type: 'loaded'; plugin: string; generation: number }
  | { type: 'unloaded'; plugin: string; generation: number }
  | { type: 'reload-failed'; plugin: string; generation: number; error: string }
  | { type: 'failed'; plugin: string; error: string }
  | { type: 'blocked'; plugin: string; error: string };

/**
 * Keeps the secrets of plugin options. The default is the operating system's credential store
 * (`experimental_keychainSecretStore`), there is no file fallback: without a store a secret cannot
 * be saved or read, and the call says why
 */
export interface PluginSecretStore {
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

/** Where the plugins' settings are read: `enabledPlugins`, `pluginConfigs`, `extraKnownMarketplaces` */
export type PluginSettingsOptions = HookSettingsOptions;

/** Limits of the process an isolated plugin runs in */
export interface PluginIsolationConfig {
  /** Milliseconds `activate` may take (default 10 000) */
  activateTimeoutMs?: number;
  /** Milliseconds a call into the plugin may take when its tool sets none (default 120 000) */
  callTimeoutMs?: number;
  /** Megabytes of heap the process may use (default 256) */
  maxHeapMb?: number;
}

/**
 * The plugins of a runtime, see `CogitatorConfig.experimental_plugins`. Plugins in code run in
 * the host's process, plugins with code from a folder (`dirs`, installed ones) in a process of
 * their own. Each loads in the order of its dependencies, a reload keeps the generation that
 * works
 */
export interface PluginsConfig {
  /** Plugins in code, first party: `experimental_definePlugin(...)` */
  plugins?: readonly PluginDefinition[];
  /** Plugin folders loaded in place, as Claude Code's `--plugin-dir`: ids `name@inline` */
  dirs?: readonly string[];
  /**
   * Load the plugins installed with `cogitator plugin install` (default true), or where they are
   * kept (default `COGITATOR_PLUGINS_DIR` or `~/.cogitator/plugins`)
   */
  installed?: boolean | { root: string };
  /**
   * Read `enabledPlugins` and `pluginConfigs` from Claude Code compatible settings files: `true`
   * (default) for the places of `permissions.settings`, or where to read. A project's own files
   * count only once it is trusted
   */
  settings?: boolean | PluginSettingsOptions;
  /** Enables or disables plugins by id over the settings files (managed settings still win) */
  enabled?: Readonly<Record<string, boolean>>;
  /** Option values by plugin id, over the settings files. Secrets go to `secrets` instead */
  options?: Readonly<Record<string, Readonly<Record<string, PluginOptionValue>>>>;
  /** Connects the MCP servers of plugins. Without it they are skipped with a diagnostic */
  mcp?: SubagentMcpConnector;
  /** Keeps the secrets of plugin options (default the operating system's credential store) */
  secrets?: PluginSecretStore;
  /** Rules that refuse what any plugin asks for, over the plugins' own `permissions` */
  permissions?: { deny?: readonly string[] };
  isolation?: PluginIsolationConfig;
  /** Reload a plugin whose folder changes (default false) */
  watch?: boolean | { debounceMs?: number };
  /** Hears each problem found in a plugin, once */
  onDiagnostic?: (diagnostic: PluginDiagnostic) => void;
  onEvent?: (event: PluginHostEvent) => void;
}

/** Where an installed plugin came from, as its install record keeps it */
export type PluginSource =
  | { source: 'path'; path: string }
  | { source: 'github'; repo: string; ref?: string; sha?: string }
  | { source: 'url'; url: string; ref?: string; sha?: string }
  | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
  | { source: 'npm'; package: string; version?: string; registry?: string }
  | { source: 'archive'; url: string; sha256?: string }
  | { source: 'command'; command: string; timeout?: number; mode?: 'copy' | 'link' };

/** What an install pinned: what the next install of the same record fetches, exactly */
export interface PluginPin {
  /** The full commit SHA of a git source */
  commit?: string;
  /** The exact npm version and its integrity (`sha512-...`) */
  npmVersion?: string;
  integrity?: string;
  /** SHA-256 of an archive, or of the files a command produced */
  sha256?: string;
}

/** A plugin `cogitator plugin install` installed */
export interface InstalledPluginRecord {
  /** `name@marketplace` */
  id: string;
  name: string;
  marketplace: string;
  /** The version its folder is named by: the manifest's, the entry's, or from the source */
  version: string;
  /** The folder it loads from */
  installPath: string;
  source: PluginSource;
  pin: PluginPin;
  /** The marketplace entry it was installed from, which stands in for a missing `plugin.json` */
  entry?: MarketplacePluginEntry;
  /** The `permissions` the user agreed to when installing or updating it */
  grantedPermissions?: PluginPermissionsSpec;
  /** Installed as a dependency of another plugin, not by the user */
  dependency?: boolean;
  installedAt: string;
  lastUpdated: string;
}

/** Where a marketplace's `marketplace.json` is fetched from */
export type MarketplaceSource =
  | { source: 'github'; repo: string; ref?: string; path?: string; sparsePaths?: readonly string[] }
  | { source: 'git'; url: string; ref?: string; path?: string; sparsePaths?: readonly string[] }
  | { source: 'url'; url: string; headers?: Readonly<Record<string, string>> }
  | { source: 'file'; path: string }
  | { source: 'directory'; path: string };

/** A plugin entry of a marketplace: where it is and the manifest fields it sets */
export interface MarketplacePluginEntry extends Partial<PluginManifest> {
  name: string;
  source: string | Exclude<PluginSource, { source: 'path' }>;
  category?: string;
  tags?: readonly string[];
  /** Whether the plugin's own `plugin.json` is the authority for its components (default true) */
  strict?: boolean;
}

/** A marketplace, its `.claude-plugin/marketplace.json` */
export interface MarketplaceManifest {
  name: string;
  owner: PluginAuthor;
  description?: string;
  version?: string;
  metadata?: { description?: string; version?: string; pluginRoot?: string };
  /** Marketplaces whose plugins may be dependencies of this one's */
  allowCrossMarketplaceDependenciesOn?: readonly string[];
  plugins: readonly MarketplacePluginEntry[];
}

/** A marketplace `cogitator plugin marketplace add` added */
export interface KnownMarketplace {
  name: string;
  source: MarketplaceSource;
  /** Where its files are: the clone, the downloaded file, or the local path itself */
  installLocation: string;
  /** The commit of a git marketplace when it was last fetched */
  commit?: string;
  lastUpdated: string;
}
