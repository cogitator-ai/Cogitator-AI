/**
 * Installing plugins as `claude plugin install` does: from the marketplaces a person added, or
 * straight from an npm package or a git repository, each install pinned to exactly what it
 * fetched (a commit, an npm version and its integrity, an archive's digest), with the permissions
 * a plugin asks for agreed to once and kept with the record
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CogitatorError,
  ErrorCode,
  type InstalledPluginRecord,
  type KnownMarketplace,
  type MarketplacePluginEntry,
  type MarketplaceSource,
  type PluginDependency,
  type PluginOptionValue,
  type PluginPermissionsSpec,
  type PluginSecretStore,
  type PluginSettingsOptions,
  type PluginSource,
} from '@cogitator-ai/types';
import { defaultUserDirs } from '../../permissions/settings';
import { marketplaceNameProblem, readPluginLayout, type PluginLayout } from '../manifest';
import { experimental_keychainSecretStore, secretServiceOf } from '../secrets';
import {
  loadPluginSettings,
  pluginSettingsFile,
  writeEnabledPlugin,
  writePluginOptions,
  type PluginSettingsScope,
} from '../settings';
import {
  defaultPluginsRoot,
  pluginDataDir,
  readInstalledPlugins,
  readKnownMarketplaces,
  writeInstalledPlugins,
  writeKnownMarketplaces,
} from '../store';
import {
  fetchMarketplace,
  gitUrlOf,
  marketplaceSourceOf,
  parseMarketplace,
  MARKETPLACE_FILE,
  copyPluginFolder,
  type ReadMarketplace,
} from './marketplace';
import { fetchPluginSource, resolveTag, splitPackage, type FetchedPlugin } from './sources';

/** How long an old version folder stays after an update, for runs that still use it */
const ORPHAN_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const ORPHAN_MARKER = '.orphaned_at';

/** What an install asks a person */
export type PluginInstallQuestion =
  | {
      kind: 'permissions';
      plugin: string;
      /** The rules the plugin asks for that were not granted yet */
      allow: readonly string[];
      deny: readonly string[];
      update: boolean;
    }
  | { kind: 'command'; plugin: string; command: string; sha256: string };

/** What the installer is built with */
export interface PluginInstallerOptions {
  /** Where plugins are kept (default `COGITATOR_PLUGINS_DIR` or `~/.cogitator/plugins`) */
  root?: string;
  /** The project whose settings `project` and `local` scopes write (default the working directory) */
  projectRoot?: string;
  /** Where the settings files are read, for `extraKnownMarketplaces` and what is enabled */
  settings?: PluginSettingsOptions;
  /** Directories of the user's settings, the first written (default `~/.cogitator`, `~/.claude`) */
  userDirs?: readonly string[];
  /** Keeps the secrets of plugin options (default the operating system's credential store) */
  secrets?: PluginSecretStore;
  /** Replaces the platform's fetch for archive and marketplace file downloads */
  fetchFn?: typeof fetch;
  /** Asks a person, for permissions a plugin wants and commands a source runs. Unset, both are refused */
  confirm?: (question: PluginInstallQuestion) => Promise<boolean>;
  onProgress?: (message: string) => void;
}

/** What an install takes besides what to install */
export interface PluginInstallOptions {
  /** Which settings file enables the plugin (default `user`) */
  scope?: PluginSettingsScope;
  /** Agree to the permissions the plugin asks for without asking */
  yes?: boolean;
  /** Option values that are not secrets, saved to `pluginConfigs` of the user's settings */
  options?: Readonly<Record<string, PluginOptionValue>>;
  /** Secret option values, saved to the credential store */
  secrets?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/** How an install went */
export interface PluginInstallResult {
  id: string;
  version: string;
  installPath: string;
  /** The records written: the plugin and the dependencies it installed */
  installed: InstalledPluginRecord[];
  alreadyInstalled: boolean;
  /** Things worth telling the person, such as options still to set */
  notes: string[];
}

/** How an update went for one plugin */
export interface PluginUpdateResult {
  id: string;
  from: string;
  to: string;
  updated: boolean;
  notes: string[];
}

function failed(
  message: string,
  code: ErrorCode = ErrorCode.PLUGIN_INSTALL_FAILED
): CogitatorError {
  return new CogitatorError({ message, code });
}

/** A version as a folder name */
function versionFolder(version: string): string {
  return version.replace(/[^A-Za-z0-9._+-]/g, '_') || 'unknown';
}

const now = () => new Date().toISOString();

/**
 * Installs, updates, enables, disables and removes plugins and the marketplaces they come from,
 * in Claude Code's formats, under `~/.cogitator/plugins`. A runtime with `experimental_plugins`
 * loads what it installed
 *
 * @example
 * ```ts
 * const installer = new experimental_PluginInstaller({ confirm: async () => true });
 * await installer.addMarketplace('your-org/claude-plugins');
 * await installer.install('formatter@your-marketplace');
 * ```
 */
export class experimental_PluginInstaller {
  readonly root: string;
  private readonly projectRoot: string;
  private readonly store: PluginSecretStore;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PluginInstallerOptions = {}) {
    this.root = resolve(options.root ?? defaultPluginsRoot());
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.store = options.secrets ?? experimental_keychainSecretStore();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private progress(message: string): void {
    this.options.onProgress?.(message);
  }

  private settingsFile(scope: PluginSettingsScope): string {
    return pluginSettingsFile(scope, this.projectRoot, {
      userDirs: [...(this.options.userDirs ?? defaultUserDirs())],
    });
  }

  /** The installed plugins */
  async list(): Promise<InstalledPluginRecord[]> {
    return (await readInstalledPlugins(this.root)).records;
  }

  /** The marketplaces added, and the ones settings files declare that were not added yet */
  async listMarketplaces(): Promise<(KnownMarketplace & { declared?: string })[]> {
    const { marketplaces } = await readKnownMarketplaces(this.root);
    const known = new Set(marketplaces.map((marketplace) => marketplace.name));
    const declared = await this.declaredMarketplaces();
    return [
      ...marketplaces,
      ...declared
        .filter((entry) => !known.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          source: entry.source,
          installLocation: '',
          lastUpdated: '',
          declared: entry.file,
        })),
    ];
  }

  private async declaredMarketplaces() {
    if (!this.options.settings) return [];
    return (await loadPluginSettings(this.projectRoot, this.options.settings)).marketplaces;
  }

  /**
   * Adds the marketplace `input` names (`owner/repo`, a git URL, an https link to a
   * `marketplace.json`, a local folder or file) and fetches it. A name already added from the same
   * source is fetched again, from another source it is refused
   */
  addMarketplace(
    input: string | MarketplaceSource,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ marketplace: KnownMarketplace; read: ReadMarketplace; alreadyAdded: boolean }> {
    return this.serial(async () => {
      const source =
        typeof input === 'string' ? marketplaceSourceOf(input, this.projectRoot) : input;
      this.progress(`Fetching the marketplace ${describeSource(source)}`);
      const fetched = await fetchMarketplace(source, this.root, {
        ...(this.options.fetchFn && { fetchFn: this.options.fetchFn }),
        ...(options.signal && { signal: options.signal }),
      });
      const name = fetched.read.manifest.name;
      const { marketplaces } = await readKnownMarketplaces(this.root);
      const existing = marketplaces.find((marketplace) => marketplace.name === name);
      if (existing && JSON.stringify(existing.source) !== JSON.stringify(source)) {
        throw failed(
          `A marketplace named ${name} is already added from ${describeSource(existing.source)}: remove it first`
        );
      }
      const marketplace: KnownMarketplace = {
        name,
        source,
        installLocation: fetched.root,
        ...(fetched.commit !== undefined && { commit: fetched.commit }),
        lastUpdated: now(),
      };
      await writeKnownMarketplaces(this.root, [
        ...marketplaces.filter((entry) => entry.name !== name),
        marketplace,
      ]);
      return { marketplace, read: fetched.read, alreadyAdded: existing !== undefined };
    });
  }

  /** Fetches the marketplace `name` again (every marketplace without one) */
  updateMarketplace(
    name?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<KnownMarketplace[]> {
    return this.serial(async () => {
      const { marketplaces } = await readKnownMarketplaces(this.root);
      const targets =
        name === undefined ? marketplaces : marketplaces.filter((entry) => entry.name === name);
      if (name !== undefined && targets.length === 0) {
        throw failed(`No marketplace ${name} is added`, ErrorCode.PLUGIN_NOT_FOUND);
      }
      const updated: KnownMarketplace[] = [];
      for (const marketplace of targets)
        updated.push(await this.refresh(marketplace, options.signal));
      return updated;
    });
  }

  private async refresh(
    marketplace: KnownMarketplace,
    signal?: AbortSignal
  ): Promise<KnownMarketplace> {
    this.progress(`Updating the marketplace ${marketplace.name}`);
    const fetched = await fetchMarketplace(marketplace.source, this.root, {
      ...(this.options.fetchFn && { fetchFn: this.options.fetchFn }),
      ...(signal && { signal }),
    });
    if (fetched.read.manifest.name !== marketplace.name) {
      throw failed(
        `The marketplace ${marketplace.name} now calls itself ${fetched.read.manifest.name}: remove it and add it again`
      );
    }
    const refreshed: KnownMarketplace = {
      ...marketplace,
      installLocation: fetched.root,
      ...(fetched.commit !== undefined && { commit: fetched.commit }),
      lastUpdated: now(),
    };
    const { marketplaces } = await readKnownMarketplaces(this.root);
    await writeKnownMarketplaces(
      this.root,
      marketplaces.map((entry) => (entry.name === marketplace.name ? refreshed : entry))
    );
    return refreshed;
  }

  /** Removes the marketplace `name`, its fetched files and every plugin installed from it */
  removeMarketplace(name: string): Promise<{ uninstalled: string[] }> {
    return this.serial(async () => {
      const { marketplaces } = await readKnownMarketplaces(this.root);
      const marketplace = marketplaces.find((entry) => entry.name === name);
      if (!marketplace) throw failed(`No marketplace ${name} is added`, ErrorCode.PLUGIN_NOT_FOUND);
      const records = await this.list();
      const uninstalled: string[] = [];
      for (const record of records.filter((entry) => entry.marketplace === name)) {
        await this.removeRecord(record, { keepData: false });
        uninstalled.push(record.id);
      }
      if (marketplace.source.source !== 'file' && marketplace.source.source !== 'directory') {
        await rm(join(this.root, 'marketplaces', name), { recursive: true, force: true });
      }
      await writeKnownMarketplaces(
        this.root,
        marketplaces.filter((entry) => entry.name !== name)
      );
      return { uninstalled };
    });
  }

  /** The marketplace `name` as its file is now, fetched again first when it is a remote one */
  async readMarketplace(
    name: string
  ): Promise<ReadMarketplace & { marketplace: KnownMarketplace }> {
    const marketplace = await this.marketplace(name);
    return { ...(await this.readKnown(marketplace)), marketplace };
  }

  private async marketplace(name: string): Promise<KnownMarketplace> {
    const problem = marketplaceNameProblem(name);
    if (problem)
      throw failed(`The marketplace name "${name}" ${problem}`, ErrorCode.VALIDATION_ERROR);
    const { marketplaces } = await readKnownMarketplaces(this.root);
    const found = marketplaces.find((entry) => entry.name === name);
    if (found) return found;
    const declared = (await this.declaredMarketplaces()).find((entry) => entry.name === name);
    if (declared) {
      const fetched = await fetchMarketplace(declared.source, this.root, {
        ...(this.options.fetchFn && { fetchFn: this.options.fetchFn }),
      });
      const marketplace: KnownMarketplace = {
        name,
        source: declared.source,
        installLocation: fetched.root,
        ...(fetched.commit !== undefined && { commit: fetched.commit }),
        lastUpdated: now(),
      };
      await writeKnownMarketplaces(this.root, [...marketplaces, marketplace]);
      return marketplace;
    }
    throw failed(
      `No marketplace ${name} is added: cogitator plugin marketplace add <source>`,
      ErrorCode.PLUGIN_NOT_FOUND
    );
  }

  private async readKnown(marketplace: KnownMarketplace): Promise<ReadMarketplace> {
    const file =
      marketplace.source.source === 'file'
        ? marketplace.source.path
        : join(
            marketplace.installLocation,
            marketplace.source.source === 'github' || marketplace.source.source === 'git'
              ? (marketplace.source.path ?? MARKETPLACE_FILE)
              : MARKETPLACE_FILE
          );
    const text = await readFile(file, 'utf8').catch(() => {
      throw failed(`The marketplace ${marketplace.name} has no file at ${file}: update it`);
    });
    return parseMarketplace(text, file, marketplace.source);
  }

  /**
   * Installs `spec`: `name@marketplace`, a `name` one added marketplace has, `npm:<package>[@version]`,
   * `github:<owner>/<repo>[#ref]` or `git+<url>[#ref]`. The plugins it depends on are installed
   * too. What it fetched is pinned in its record, the permissions it asks for are agreed to first
   */
  install(spec: string, options: PluginInstallOptions = {}): Promise<PluginInstallResult> {
    return this.serial(async () => {
      await this.sweepOrphans();
      const direct = directSource(spec);
      if (direct) {
        return this.installEntry(direct.entry, direct.marketplace, undefined, options, []);
      }
      const { name, marketplace } = await this.findEntry(spec);
      const notes: string[] = [];
      let known = marketplace;
      if (known.source.source !== 'file' && known.source.source !== 'directory') {
        try {
          known = await this.refresh(known, options.signal);
        } catch (error) {
          notes.push(
            `marketplace not refreshed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const read = await this.readKnown(known);
      const entry = read.manifest.plugins.find((candidate) => candidate.name === name);
      if (!entry)
        throw failed(
          `The marketplace ${known.name} has no plugin ${name}`,
          ErrorCode.PLUGIN_NOT_FOUND
        );
      const result = await this.installEntry(entry, known.name, { known, read }, options, []);
      return { ...result, notes: [...notes, ...result.notes] };
    });
  }

  private async findEntry(spec: string): Promise<{ name: string; marketplace: KnownMarketplace }> {
    const at = spec.lastIndexOf('@');
    if (at > 0) {
      return { name: spec.slice(0, at), marketplace: await this.marketplace(spec.slice(at + 1)) };
    }
    const { marketplaces } = await readKnownMarketplaces(this.root);
    const matches: KnownMarketplace[] = [];
    for (const marketplace of marketplaces) {
      const read = await this.readKnown(marketplace).catch(() => undefined);
      if (read?.manifest.plugins.some((entry) => entry.name === spec)) matches.push(marketplace);
    }
    if (matches.length === 0) {
      throw failed(`No added marketplace has a plugin ${spec}`, ErrorCode.PLUGIN_NOT_FOUND);
    }
    if (matches.length > 1) {
      throw failed(
        `${spec} is in several marketplaces (${matches.map((entry) => entry.name).join(', ')}): name it as ${spec}@<marketplace>`
      );
    }
    const [only] = matches;
    if (!only)
      throw failed(`No added marketplace has a plugin ${spec}`, ErrorCode.PLUGIN_NOT_FOUND);
    return { name: spec, marketplace: only };
  }

  private async installEntry(
    entry: MarketplacePluginEntry,
    marketplaceName: string,
    marketplace: { known: KnownMarketplace; read: ReadMarketplace } | undefined,
    options: PluginInstallOptions,
    chain: readonly string[],
    dependency = false
  ): Promise<PluginInstallResult> {
    const records = await this.list();
    const direct = marketplace === undefined;
    const provisionalId = `${entry.name}@${marketplaceName}`;
    if (chain.includes(provisionalId)) {
      throw failed(
        `Plugins depend on each other in a cycle: ${[...chain, provisionalId].join(' -> ')}`,
        ErrorCode.PLUGIN_DEPENDENCY_CYCLE
      );
    }
    const existing = records.find((record) => record.id === provisionalId);
    if (existing && !direct) {
      if (!dependency) await this.enable(existing.id, options.scope ?? 'user');
      return {
        id: existing.id,
        version: existing.version,
        installPath: existing.installPath,
        installed: [],
        alreadyInstalled: true,
        notes: [],
      };
    }
    this.progress(`Fetching ${provisionalId}`);
    const staging = await mkdtemp(join(await ensure(this.root), '.staging-'));
    try {
      const fetched = await fetchPluginSource(entry.source, {
        staging,
        ...(marketplace && {
          marketplace: {
            root: marketplace.known.installLocation,
            source: marketplace.known.source,
            ...(marketplace.read.manifest.metadata?.pluginRoot !== undefined && {
              pluginRoot: marketplace.read.manifest.metadata.pluginRoot,
            }),
          },
        }),
        ...(this.options.fetchFn && { fetchFn: this.options.fetchFn }),
        acceptCommand: async (command) =>
          (await this.options.confirm?.({
            kind: 'command',
            plugin: provisionalId,
            command,
            sha256: createHash('sha256').update(command).digest('hex'),
          })) === true,
        ...(options.signal && { signal: options.signal }),
      });
      const layout = await readPluginLayout(fetched.dir, {
        entry,
        fallbackName: direct ? fallbackNameOf(entry) : entry.name,
        id: provisionalId,
      });
      if (layout.fatal.length > 0) {
        throw failed(
          `${provisionalId} is not a valid plugin: ${layout.fatal.join(', ')}`,
          ErrorCode.PLUGIN_INVALID
        );
      }
      const name = direct ? layout.manifest.name : entry.name;
      const id = `${name}@${marketplaceName}`;
      const prior = records.find((record) => record.id === id);
      if (prior && direct) {
        return {
          id,
          version: prior.version,
          installPath: prior.installPath,
          installed: [],
          alreadyInstalled: true,
          notes: [`${id} is installed already: cogitator plugin update ${id}`],
        };
      }
      const version = versionOf(layout, entry, fetched);
      const granted = await this.grant(id, layout, undefined, options.yes === true, false);
      const installed: InstalledPluginRecord[] = [];
      for (const need of layout.manifest.dependencies ?? []) {
        const installedDependency = await this.installDependency(
          need,
          marketplaceName,
          marketplace?.read,
          options,
          [...chain, id],
          records
        );
        installed.push(...installedDependency);
      }
      const installPath = fetched.inPlace
        ? fetched.dir
        : join(this.root, 'cache', marketplaceName, name, versionFolder(version));
      if (!fetched.inPlace) {
        this.progress(`Installing ${id} ${version}`);
        await copyPluginFolder(fetched.dir, installPath);
      }
      const record: InstalledPluginRecord = {
        id,
        name,
        marketplace: marketplaceName,
        version,
        installPath,
        source: fetched.source,
        pin: fetched.pin,
        entry: direct ? { ...entry, name } : entry,
        ...(granted && { grantedPermissions: granted }),
        ...(dependency && { dependency: true }),
        installedAt: now(),
        lastUpdated: now(),
      };
      const latest = await this.list();
      await writeInstalledPlugins(this.root, [
        ...latest.filter((candidate) => candidate.id !== id),
        record,
      ]);
      installed.unshift(record);
      if (!dependency)
        await writeEnabledPlugin(this.settingsFile(options.scope ?? 'user'), id, true);
      const notes = await this.saveOptions(id, layout, options);
      return { id, version, installPath, installed, alreadyInstalled: false, notes };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Installs a dependency that is not installed yet, at a version its range allows */
  private async installDependency(
    need: PluginDependency,
    marketplaceName: string,
    read: ReadMarketplace | undefined,
    options: PluginInstallOptions,
    chain: readonly string[],
    records: readonly InstalledPluginRecord[]
  ): Promise<InstalledPluginRecord[]> {
    const target = need.marketplace ?? marketplaceName;
    const id = `${need.name}@${target}`;
    if (records.some((record) => record.id === id)) return [];
    if (need.marketplace !== undefined && need.marketplace !== marketplaceName) {
      const allowed = read?.manifest.allowCrossMarketplaceDependenciesOn ?? [];
      if (!allowed.includes(need.marketplace)) {
        throw failed(
          `Dependency "${id}" is in another marketplace, which ${marketplaceName} does not allow (allowCrossMarketplaceDependenciesOn)`,
          ErrorCode.PLUGIN_DEPENDENCY_UNMET
        );
      }
    }
    const known = await this.marketplace(target).catch(() => undefined);
    if (!known) {
      throw failed(
        `Dependency "${id}" cannot be installed: the marketplace ${target} is not added`,
        ErrorCode.PLUGIN_DEPENDENCY_UNMET
      );
    }
    const ownRead = await this.readKnown(known);
    const entry = ownRead.manifest.plugins.find((candidate) => candidate.name === need.name);
    if (!entry)
      throw failed(
        `Dependency "${id}" is not in the marketplace ${target}`,
        ErrorCode.PLUGIN_DEPENDENCY_UNMET
      );
    let pinned: MarketplacePluginEntry = entry;
    if (need.version !== undefined && typeof entry.source === 'object') {
      const source = entry.source;
      if (source.source === 'github' || source.source === 'url' || source.source === 'git-subdir') {
        const url = source.source === 'github' ? gitUrlOf(source) : source.url;
        const tag = await resolveTag(url, need.name, need.version);
        if (!tag) {
          throw failed(
            `Dependency "${id}" has no git tag satisfying ${need.version}`,
            ErrorCode.PLUGIN_DEPENDENCY_UNMET
          );
        }
        const { sha: _sha, ...rest } = source;
        pinned = { ...entry, source: { ...rest, ref: tag.tag } };
      } else if (source.source === 'npm') {
        pinned = { ...entry, source: { ...source, version: need.version } };
      }
    }
    const result = await this.installEntry(
      pinned,
      target,
      { known, read: ownRead },
      { ...options, scope: 'user' },
      chain,
      true
    );
    return result.installed;
  }

  /**
   * The permissions `id` may have: the ones granted before and the ones a person agrees to now.
   * Without a confirm callback (and without `yes`) nothing new is granted: an install fails, an
   * update keeps what was granted
   */
  private async grant(
    id: string,
    layout: PluginLayout,
    before: PluginPermissionsSpec | undefined,
    yes: boolean,
    update: boolean
  ): Promise<PluginPermissionsSpec | undefined> {
    const asked = layout.manifest.permissions;
    if (!asked) return before;
    const had = new Set(before?.allow ?? []);
    const wanted = (asked.allow ?? []).filter((rule) => !had.has(rule));
    const deny = asked.deny ?? [];
    if (wanted.length === 0) return { allow: [...had], deny: [...deny] };
    const agreed =
      yes ||
      ((await this.options.confirm?.({
        kind: 'permissions',
        plugin: id,
        allow: wanted,
        deny,
        update,
      })) ??
        false);
    if (!agreed) {
      if (update) return { allow: [...had], deny: [...deny] };
      throw failed(
        `${id} asks for permissions that were not granted: ${wanted.join(', ')}. Install it with --yes to grant them`,
        ErrorCode.PLUGIN_PERMISSION_DENIED
      );
    }
    return { allow: [...had, ...wanted], deny: [...deny] };
  }

  private async saveOptions(
    id: string,
    layout: PluginLayout,
    options: PluginInstallOptions
  ): Promise<string[]> {
    const spec = layout.manifest.userConfig ?? {};
    const values = options.options ?? {};
    const secrets = options.secrets ?? {};
    for (const key of [...Object.keys(values), ...Object.keys(secrets)]) {
      if (!Object.hasOwn(spec, key))
        throw failed(`${id} declares no option ${key}`, ErrorCode.VALIDATION_ERROR);
    }
    const plain: Record<string, PluginOptionValue> = {};
    for (const [key, value] of Object.entries(values)) {
      if (spec[key]?.sensitive === true) {
        throw failed(
          `The option ${key} of ${id} is sensitive: give it as a secret`,
          ErrorCode.VALIDATION_ERROR
        );
      }
      plain[key] = value;
    }
    if (Object.keys(plain).length > 0)
      await writePluginOptions(this.settingsFile('user'), id, plain);
    for (const [key, secret] of Object.entries(secrets)) {
      if (spec[key]?.sensitive !== true) {
        throw failed(
          `The option ${key} of ${id} is not sensitive: give it as an option`,
          ErrorCode.VALIDATION_ERROR
        );
      }
      await this.store.set(secretServiceOf(id), key, secret);
    }
    const settings = await loadPluginSettings(this.projectRoot, {
      userDirs: [...(this.options.userDirs ?? defaultUserDirs())],
      layers: ['user'],
    });
    const saved = settings.options[id] ?? {};
    const unset: string[] = [];
    for (const [key, option] of Object.entries(spec)) {
      if (option.default !== undefined || Object.hasOwn(saved, key) || Object.hasOwn(secrets, key))
        continue;
      if (
        option.sensitive === true &&
        (await this.store.get(secretServiceOf(id), key).catch(() => undefined)) !== undefined
      )
        continue;
      unset.push(key);
    }
    return unset.length > 0
      ? [`userConfig options not yet set: ${unset.join(', ')} (cogitator plugin configure ${id})`]
      : [];
  }

  /** Sets option values (and secrets) of the installed plugin `id` */
  configure(
    id: string,
    values: {
      options?: Readonly<Record<string, PluginOptionValue>>;
      secrets?: Readonly<Record<string, string>>;
      unset?: readonly string[];
    }
  ): Promise<string[]> {
    return this.serial(async () => {
      const record = await this.record(id);
      const layout = await readPluginLayout(record.installPath, {
        ...(record.entry && { entry: record.entry }),
        fallbackName: record.name,
        id,
      });
      for (const key of values.unset ?? []) {
        const option = layout.manifest.userConfig?.[key];
        if (!option) throw failed(`${id} declares no option ${key}`, ErrorCode.VALIDATION_ERROR);
        if (option.sensitive === true) await this.store.delete(secretServiceOf(id), key);
        else await writePluginOptions(this.settingsFile('user'), id, { [key]: undefined });
      }
      return this.saveOptions(id, layout, {
        ...(values.options && { options: values.options }),
        ...(values.secrets && { secrets: values.secrets }),
      });
    });
  }

  private async record(id: string): Promise<InstalledPluginRecord> {
    const record = (await this.list()).find(
      (entry) => entry.id === id || (!id.includes('@') && entry.name === id)
    );
    if (!record) throw failed(`No plugin ${id} is installed`, ErrorCode.PLUGIN_NOT_FOUND);
    return record;
  }

  /**
   * Fetches the plugin `id` (every installed plugin without one) from its source again, and
   * installs the new version when it differs: a manifest that pins its `version` keeps the
   * installed copy until the version changes, as in Claude Code
   */
  update(
    id?: string,
    options: { yes?: boolean; signal?: AbortSignal } = {}
  ): Promise<PluginUpdateResult[]> {
    return this.serial(async () => {
      const records = await this.list();
      const targets = id === undefined ? records : [await this.record(id)];
      const results: PluginUpdateResult[] = [];
      for (const record of targets) results.push(await this.updateOne(record, options));
      return results;
    });
  }

  private async updateOne(
    record: InstalledPluginRecord,
    options: { yes?: boolean; signal?: AbortSignal }
  ): Promise<PluginUpdateResult> {
    const direct = ['npm', 'git', 'github'].includes(record.marketplace);
    const notes: string[] = [];
    let entry = record.entry;
    let marketplace: { known: KnownMarketplace; read: ReadMarketplace } | undefined;
    if (!direct) {
      let known = await this.marketplace(record.marketplace);
      if (known.source.source !== 'file' && known.source.source !== 'directory') {
        try {
          known = await this.refresh(known, options.signal);
        } catch (error) {
          notes.push(
            `marketplace not refreshed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const read = await this.readKnown(known);
      entry = read.manifest.plugins.find((candidate) => candidate.name === record.name);
      if (!entry)
        throw failed(
          `The marketplace ${record.marketplace} no longer has ${record.name}`,
          ErrorCode.PLUGIN_NOT_FOUND
        );
      marketplace = { known, read };
    }
    if (!entry) throw failed(`The record of ${record.id} keeps no source to update from`);
    const staging = await mkdtemp(join(await ensure(this.root), '.staging-'));
    try {
      const fetched = await fetchPluginSource(entry.source, {
        staging,
        ...(marketplace && {
          marketplace: {
            root: marketplace.known.installLocation,
            source: marketplace.known.source,
            ...(marketplace.read.manifest.metadata?.pluginRoot !== undefined && {
              pluginRoot: marketplace.read.manifest.metadata.pluginRoot,
            }),
          },
        }),
        ...(this.options.fetchFn && { fetchFn: this.options.fetchFn }),
        acceptCommand: async (command) =>
          (await this.options.confirm?.({
            kind: 'command',
            plugin: record.id,
            command,
            sha256: createHash('sha256').update(command).digest('hex'),
          })) === true,
        ...(options.signal && { signal: options.signal }),
      });
      const layout = await readPluginLayout(fetched.dir, {
        entry,
        fallbackName: record.name,
        id: record.id,
      });
      if (layout.fatal.length > 0) {
        throw failed(
          `The new version of ${record.id} is not a valid plugin: ${layout.fatal.join(', ')}`,
          ErrorCode.PLUGIN_INVALID
        );
      }
      const version = versionOf(layout, entry, fetched);
      if (version === record.version && !fetched.inPlace) {
        return {
          id: record.id,
          from: record.version,
          to: version,
          updated: false,
          notes: [...notes, `${record.name} is already at the latest version (${version}).`],
        };
      }
      const granted = await this.grant(
        record.id,
        layout,
        record.grantedPermissions,
        options.yes === true,
        true
      );
      if (
        granted &&
        (layout.manifest.permissions?.allow ?? []).some(
          (rule) => !(granted.allow ?? []).includes(rule)
        )
      ) {
        notes.push(
          'Some permissions of the new version were not granted, the plugin runs without them'
        );
      }
      const installPath = fetched.inPlace
        ? fetched.dir
        : join(this.root, 'cache', record.marketplace, record.name, versionFolder(version));
      if (!fetched.inPlace) await copyPluginFolder(fetched.dir, installPath);
      if (
        record.installPath !== installPath &&
        isUnder(join(this.root, 'cache'), record.installPath)
      ) {
        await writeFile(join(record.installPath, ORPHAN_MARKER), now()).catch(() => undefined);
      }
      const updated: InstalledPluginRecord = {
        ...record,
        version,
        installPath,
        source: fetched.source,
        pin: fetched.pin,
        entry: direct ? (record.entry ?? entry) : entry,
        ...(granted && { grantedPermissions: granted }),
        lastUpdated: now(),
      };
      const latest = await this.list();
      await writeInstalledPlugins(
        this.root,
        latest.map((candidate) => (candidate.id === record.id ? updated : candidate))
      );
      return { id: record.id, from: record.version, to: version, updated: true, notes };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Removes the installed plugin `id`: its files, its data folder (unless `keepData`), its options
   * and secrets and its `enabledPlugins` entries. Refused while an installed plugin depends on it.
   * With `prune`, dependencies nothing needs any more go too
   */
  uninstall(
    id: string,
    options: { keepData?: boolean; prune?: boolean } = {}
  ): Promise<{ removed: string[]; keptData: boolean }> {
    return this.serial(async () => {
      const record = await this.record(id);
      const records = await this.list();
      const dependents = await this.dependentsOf(record, records);
      if (dependents.length > 0) {
        throw failed(
          `${record.id} is needed by ${dependents.join(', ')}: uninstall them first`,
          ErrorCode.PLUGIN_DEPENDENCY_UNMET
        );
      }
      await this.removeRecord(record, { keepData: options.keepData === true });
      const removed = [record.id];
      if (options.prune) {
        let changed = true;
        while (changed) {
          changed = false;
          const left = await this.list();
          for (const candidate of left.filter((entry) => entry.dependency)) {
            if ((await this.dependentsOf(candidate, left)).length === 0) {
              await this.removeRecord(candidate, { keepData: false });
              removed.push(candidate.id);
              changed = true;
            }
          }
        }
      }
      return { removed, keptData: options.keepData === true };
    });
  }

  private async dependentsOf(
    record: InstalledPluginRecord,
    records: readonly InstalledPluginRecord[]
  ): Promise<string[]> {
    const dependents: string[] = [];
    for (const candidate of records) {
      if (candidate.id === record.id) continue;
      const layout = await readPluginLayout(candidate.installPath, {
        ...(candidate.entry && { entry: candidate.entry }),
        fallbackName: candidate.name,
      }).catch(() => undefined);
      const needs = (layout?.manifest.dependencies ?? []).some(
        (need) =>
          need.name === record.name &&
          (need.marketplace ?? candidate.marketplace) === record.marketplace
      );
      if (needs) dependents.push(candidate.id);
    }
    return dependents;
  }

  private async removeRecord(
    record: InstalledPluginRecord,
    options: { keepData: boolean }
  ): Promise<void> {
    const layout = await readPluginLayout(record.installPath, {
      ...(record.entry && { entry: record.entry }),
      fallbackName: record.name,
    }).catch(() => undefined);
    for (const [key, option] of Object.entries(layout?.manifest.userConfig ?? {})) {
      if (option.sensitive === true)
        await this.store.delete(secretServiceOf(record.id), key).catch(() => undefined);
    }
    if (isUnder(join(this.root, 'cache'), record.installPath)) {
      await rm(record.installPath, { recursive: true, force: true });
    }
    if (!options.keepData)
      await rm(pluginDataDir(this.root, record.id), { recursive: true, force: true });
    await writePluginOptions(this.settingsFile('user'), record.id, undefined);
    for (const scope of ['user', 'project', 'local'] as const) {
      const file = this.settingsFile(scope);
      if (existsSync(file)) await writeEnabledPlugin(file, record.id, undefined);
    }
    const latest = await this.list();
    await writeInstalledPlugins(
      this.root,
      latest.filter((candidate) => candidate.id !== record.id)
    );
  }

  private async enable(id: string, scope: PluginSettingsScope): Promise<void> {
    await writeEnabledPlugin(this.settingsFile(scope), id, true);
  }

  /**
   * Enables or disables the installed plugin `id` in the settings file of `scope` (default
   * `user`). Enabling needs its dependencies installed, disabling is refused while an enabled
   * plugin depends on it
   */
  setEnabled(
    id: string,
    enabled: boolean,
    scope: PluginSettingsScope = 'user'
  ): Promise<{ file: string }> {
    return this.serial(async () => {
      const record = await this.record(id);
      const records = await this.list();
      const settings = await loadPluginSettings(this.projectRoot, {
        root: this.projectRoot,
        userDirs: [...(this.options.userDirs ?? defaultUserDirs())],
        trusted: true,
        ...(this.options.settings?.managedDirs && {
          managedDirs: this.options.settings.managedDirs,
        }),
      });
      const managed = settings.enabled.get(record.id);
      if (managed?.layer === 'managed') {
        throw failed(
          `${record.id} is ${managed.value ? 'enabled' : 'disabled'} by managed settings, which no other settings override`
        );
      }
      if (enabled) {
        const layout = await readPluginLayout(record.installPath, {
          ...(record.entry && { entry: record.entry }),
          fallbackName: record.name,
        });
        const missing = (layout.manifest.dependencies ?? []).filter(
          (need) =>
            !records.some(
              (candidate) =>
                candidate.name === need.name &&
                candidate.marketplace === (need.marketplace ?? record.marketplace)
            )
        );
        if (missing.length > 0) {
          throw failed(
            `${record.id} needs ${missing.map((need) => `${need.name}@${need.marketplace ?? record.marketplace}`).join(', ')}: cogitator plugin install ${missing.map((need) => `${need.name}@${need.marketplace ?? record.marketplace}`).join(' ')}`,
            ErrorCode.PLUGIN_DEPENDENCY_UNMET
          );
        }
      } else {
        const dependents = (await this.dependentsOf(record, records)).filter(
          (dependent) => settings.enabled.get(dependent)?.value !== false
        );
        if (dependents.length > 0) {
          throw failed(
            `${record.id} is needed by ${dependents.join(', ')}: disable them first`,
            ErrorCode.PLUGIN_DEPENDENCY_UNMET
          );
        }
      }
      const file = this.settingsFile(scope);
      await writeEnabledPlugin(file, record.id, enabled);
      return { file };
    });
  }

  /** Removes version folders an update left behind once they are 14 days old */
  private async sweepOrphans(): Promise<void> {
    const cache = join(this.root, 'cache');
    const walk = async (dir: string, depth: number): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        if (depth < 2) {
          await walk(path, depth + 1);
          continue;
        }
        const marker = join(path, ORPHAN_MARKER);
        const info = await stat(marker).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > ORPHAN_GRACE_MS)
          await rm(path, { recursive: true, force: true });
      }
    };
    await walk(cache, 0);
  }
}

async function ensure(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

function isUnder(root: string, path: string): boolean {
  const resolved = resolve(path);
  const base = resolve(root);
  return resolved.startsWith(`${base}/`) || resolved.startsWith(`${base}\\`);
}

/** The version a plugin is installed as: its manifest's, its entry's, else from where it came */
function versionOf(
  layout: PluginLayout,
  entry: MarketplacePluginEntry,
  fetched: FetchedPlugin
): string {
  const declared = layout.manifest.version ?? entry.version;
  if (typeof entry.source === 'object' && entry.source.source === 'command') {
    return declared !== undefined ? `${declared}-${fetched.sourceVersion}` : fetched.sourceVersion;
  }
  return declared ?? fetched.sourceVersion;
}

/** The name of a plugin installed straight from a source, before its manifest is read */
function fallbackNameOf(entry: MarketplacePluginEntry): string {
  const source = entry.source;
  if (typeof source === 'object') {
    if (source.source === 'npm')
      return splitPackage(source.package).name.split('/').pop() ?? entry.name;
    if (source.source === 'github') return source.repo.split('/').pop() ?? entry.name;
    if (source.source === 'url' || source.source === 'git-subdir') {
      return (
        (source.source === 'git-subdir' ? source.path : source.url)
          .replace(/\.git$/, '')
          .split(/[/:]/)
          .filter(Boolean)
          .pop() ?? entry.name
      );
    }
  }
  return entry.name;
}

/** The source of a direct install (`npm:`, `github:`, `git+`), and the marketplace part of its id */
function directSource(
  spec: string
): { entry: MarketplacePluginEntry; marketplace: string } | undefined {
  const refOf = (text: string): { base: string; ref?: string } => {
    const hash = text.indexOf('#');
    return hash === -1 ? { base: text } : { base: text.slice(0, hash), ref: text.slice(hash + 1) };
  };
  const pinned = (ref: string | undefined) =>
    ref === undefined ? {} : /^[0-9a-f]{40}$/.test(ref) ? { sha: ref } : { ref };
  if (spec.startsWith('npm:')) {
    const value = spec.slice(4);
    const { name } = splitPackage(value);
    return {
      entry: { name: name.split('/').pop() ?? name, source: { source: 'npm', package: value } },
      marketplace: 'npm',
    };
  }
  if (spec.startsWith('github:')) {
    const { base, ref } = refOf(spec.slice(7));
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(base)) {
      throw failed(`${spec}: github: takes owner/repo`, ErrorCode.VALIDATION_ERROR);
    }
    return {
      entry: {
        name: base.split('/')[1] ?? base,
        source: { source: 'github', repo: base, ...pinned(ref) },
      },
      marketplace: 'github',
    };
  }
  if (spec.startsWith('git+')) {
    const { base, ref } = refOf(spec.slice(4));
    const source: PluginSource = { source: 'url', url: base, ...pinned(ref) };
    return {
      entry: {
        name:
          base
            .replace(/\.git$/, '')
            .split(/[/:]/)
            .filter(Boolean)
            .pop() ?? 'plugin',
        source: source as Exclude<PluginSource, { source: 'path' }>,
      },
      marketplace: 'git',
    };
  }
  return undefined;
}

function describeSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return `github ${source.repo}${source.ref ? `#${source.ref}` : ''}`;
    case 'git':
      return `git ${source.url}${source.ref ? `#${source.ref}` : ''}`;
    case 'url':
      return source.url;
    case 'file':
    case 'directory':
      return source.path;
  }
}
