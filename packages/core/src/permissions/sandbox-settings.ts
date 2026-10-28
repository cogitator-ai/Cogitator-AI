/**
 * The `sandbox` section of Claude Code compatible settings files, read and merged across the
 * layers into the policy of an OS sandbox (`OsSandbox` of `@cogitator-ai/sandbox`)
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  OsSandboxPolicy,
  PermissionLayer,
  PermissionLayerSettings,
  SandboxSettingsFile,
} from '@cogitator-ai/types';
import { parseRule } from './rules';

type FileLayer = Exclude<PermissionLayer, 'session'>;
type Filesystem = NonNullable<SandboxSettingsFile['filesystem']>;
type Network = NonNullable<SandboxSettingsFile['network']>;
type Credentials = NonNullable<SandboxSettingsFile['credentials']>;

/** Keys of Claude Code's `sandbox` settings Cogitator does not support: they are left out with a warning */
const UNSUPPORTED = new Set([
  'enableWeakerNestedSandbox',
  'enableWeakerNetworkIsolation',
  'allowAppleEvents',
  'allowNestedUserNamespaces',
  'ripgrep',
  'allowPty',
  'mandatoryDenySearchDepth',
]);
const UNSUPPORTED_NETWORK = new Set([
  'httpProxyPort',
  'socksProxyPort',
  'tlsTerminate',
  'allowMachLookup',
  'deniedDomainReasons',
  'deniedResolvedAddresses',
  'parentProxy',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boolOf(
  value: unknown,
  field: string,
  origin: string,
  warnings: string[]
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  warnings.push(`${origin}: sandbox.${field} is not a boolean, it is ignored`);
  return undefined;
}

function stringsOf(
  value: unknown,
  field: string,
  origin: string,
  warnings: string[]
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${origin}: sandbox.${field} is not a list, it is ignored`);
    return undefined;
  }
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') strings.push(entry);
    else warnings.push(`${origin}: an entry of sandbox.${field} is not a string, it is ignored`);
  }
  return strings;
}

function warnUnknown(
  value: Record<string, unknown>,
  known: readonly string[],
  unsupported: ReadonlySet<string>,
  prefix: string,
  origin: string,
  warnings: string[]
): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    warnings.push(
      unsupported.has(key)
        ? `${origin}: sandbox.${prefix}${key} is not supported by Cogitator, it is ignored`
        : `${origin}: sandbox.${prefix}${key} is not a sandbox setting, it is ignored`
    );
  }
}

/** The `sandbox` section of a settings file, problems with it in `warnings` */
export function readSandboxSection(
  raw: unknown,
  origin: string,
  warnings: string[]
): SandboxSettingsFile | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`${origin}: sandbox is not an object, it is ignored`);
    return undefined;
  }
  warnUnknown(
    raw,
    [
      'enabled',
      'failIfUnavailable',
      'autoAllowBashIfSandboxed',
      'allowUnsandboxedCommands',
      'excludedCommands',
      'ignoreViolations',
      'bwrapPath',
      'socatPath',
      'filesystem',
      'network',
      'credentials',
    ],
    UNSUPPORTED,
    '',
    origin,
    warnings
  );
  const section: SandboxSettingsFile = {};
  const flags = [
    'enabled',
    'failIfUnavailable',
    'autoAllowBashIfSandboxed',
    'allowUnsandboxedCommands',
  ] as const;
  for (const key of flags) {
    const value = boolOf(raw[key], key, origin, warnings);
    if (value !== undefined) section[key] = value;
  }
  const excluded = stringsOf(raw.excludedCommands, 'excludedCommands', origin, warnings);
  if (excluded) section.excludedCommands = excluded;
  for (const key of ['bwrapPath', 'socatPath'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && isAbsolute(value)) section[key] = value;
    else warnings.push(`${origin}: sandbox.${key} is not an absolute path, it is ignored`);
  }
  if (raw.ignoreViolations !== undefined) {
    if (!isRecord(raw.ignoreViolations)) {
      warnings.push(`${origin}: sandbox.ignoreViolations is not an object, it is ignored`);
    } else {
      const ignore: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(raw.ignoreViolations)) {
        const list = stringsOf(value, `ignoreViolations.${key}`, origin, warnings);
        if (list) ignore[key] = list;
      }
      section.ignoreViolations = ignore;
    }
  }
  const filesystem = readFilesystem(raw.filesystem, origin, warnings);
  if (filesystem) section.filesystem = filesystem;
  const network = readNetwork(raw.network, origin, warnings);
  if (network) section.network = network;
  const credentials = readCredentials(raw.credentials, origin, warnings);
  if (credentials) section.credentials = credentials;
  return section;
}

function readFilesystem(raw: unknown, origin: string, warnings: string[]): Filesystem | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`${origin}: sandbox.filesystem is not an object, it is ignored`);
    return undefined;
  }
  const lists = ['allowWrite', 'denyWrite', 'denyRead', 'allowRead'] as const;
  const flags = ['allowManagedReadPathsOnly', 'disabled'] as const;
  warnUnknown(raw, [...lists, ...flags], new Set(), 'filesystem.', origin, warnings);
  const filesystem: Filesystem = {};
  for (const key of lists) {
    const list = stringsOf(raw[key], `filesystem.${key}`, origin, warnings);
    if (list) filesystem[key] = list;
  }
  for (const key of flags) {
    const value = boolOf(raw[key], `filesystem.${key}`, origin, warnings);
    if (value !== undefined) filesystem[key] = value;
  }
  return filesystem;
}

function readNetwork(raw: unknown, origin: string, warnings: string[]): Network | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`${origin}: sandbox.network is not an object, it is ignored`);
    return undefined;
  }
  const lists = ['allowedDomains', 'deniedDomains', 'allowUnixSockets'] as const;
  const flags = [
    'strictAllowlist',
    'allowManagedDomainsOnly',
    'allowLocalBinding',
    'allowAllUnixSockets',
  ] as const;
  warnUnknown(raw, [...lists, ...flags], UNSUPPORTED_NETWORK, 'network.', origin, warnings);
  const network: Network = {};
  for (const key of lists) {
    const list = stringsOf(raw[key], `network.${key}`, origin, warnings);
    if (list) network[key] = list;
  }
  for (const key of flags) {
    const value = boolOf(raw[key], `network.${key}`, origin, warnings);
    if (value !== undefined) network[key] = value;
  }
  return network;
}

function readCredentials(
  raw: unknown,
  origin: string,
  warnings: string[]
): Credentials | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push(`${origin}: sandbox.credentials is not an object, it is ignored`);
    return undefined;
  }
  warnUnknown(
    raw,
    ['files', 'envVars'],
    new Set(['allowPlaintextInject', 'awsPairs', 'sigv4']),
    'credentials.',
    origin,
    warnings
  );
  const credentials: Credentials = {};
  const entries = (
    value: unknown,
    field: 'files' | 'envVars',
    key: 'path' | 'name'
  ): Array<{ value: string; mode: 'deny' | 'mask' }> => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      warnings.push(`${origin}: sandbox.credentials.${field} is not a list, it is ignored`);
      return [];
    }
    const out: Array<{ value: string; mode: 'deny' | 'mask' }> = [];
    for (const entry of value) {
      const text = isRecord(entry) ? entry[key] : undefined;
      const mode = isRecord(entry) ? entry.mode : undefined;
      if (typeof text !== 'string' || (mode !== 'deny' && mode !== 'mask')) {
        warnings.push(
          `${origin}: an entry of sandbox.credentials.${field} needs a ${key} and a mode of deny or mask, it is ignored`
        );
        continue;
      }
      if (mode === 'mask') {
        warnings.push(
          `${origin}: sandbox.credentials.${field} ${text} has mode mask, which Cogitator does not support: it is denied instead`
        );
      }
      out.push({ value: text, mode });
    }
    return out;
  };
  const files = entries(raw.files, 'files', 'path');
  const envVars = entries(raw.envVars, 'envVars', 'name');
  if (files.length > 0) credentials.files = files.map(({ value, mode }) => ({ path: value, mode }));
  if (envVars.length > 0) {
    credentials.envVars = envVars.map(({ value, mode }) => ({ name: value, mode }));
  }
  return credentials;
}

/** What {@link sandboxPolicyOf} made of the layers: the policy and what was left out */
export interface SandboxPolicyResult {
  policy: OsSandboxPolicy & { enabled: boolean };
  warnings: string[];
}

const ORDER: Record<FileLayer, number> = { managed: 0, local: 1, project: 2, user: 3 };

/**
 * A path of a `sandbox.filesystem` list: `/x` and `//x` absolute, `~/x` in the home directory,
 * anything else relative to the file's anchor (the project root for project and local files,
 * the settings directory for user and managed ones)
 */
export function sandboxSettingsPath(entry: string, anchor: string, home = homedir()): string {
  const text = entry.trim();
  if (text.startsWith('//')) return text.slice(1);
  if (text === '~') return home;
  if (text.startsWith('~/')) return join(home, text.slice(2));
  if (isAbsolute(text)) return text;
  return resolve(anchor, text);
}

/**
 * The path a `Read(...)` or `Edit(...)` rule names, for the sandbox: `//x` absolute, `~/x` in the
 * home directory, `/x` and `./x` from the file's anchor, and a pattern without a slash
 * (`*.env`) at any depth under it, as the rules match it
 */
function rulePath(specifier: string, anchor: string, home: string): string | undefined {
  const text = specifier.trim();
  if (text === '' || text.startsWith('!')) return undefined;
  if (text.startsWith('//')) return text.slice(1);
  if (text === '~') return home;
  if (text.startsWith('~/')) return join(home, text.slice(2));
  if (text.startsWith('/')) return join(anchor, text.slice(1));
  if (text.startsWith('./')) return join(anchor, text.slice(2));
  return text.includes('/') ? join(anchor, text) : join(anchor, '**', text);
}

/** The sandbox domain entries a `WebFetch(domain:...)` rule stands for: the host and its subdomains */
function ruleDomains(specifier: string): string[] {
  const colon = specifier.indexOf(':');
  if (colon === -1 || specifier.slice(0, colon).trim() !== 'domain') return [];
  const domain = specifier
    .slice(colon + 1)
    .trim()
    .toLowerCase();
  if (domain === '' || /\s/.test(domain)) return [];
  if (domain === '*' || domain.startsWith('*.')) return [domain];
  if (domain.includes('*')) return [];
  return [domain, `*.${domain}`];
}

/** The path and domain entries the permission rules of a layer add to the sandbox lists */
function rulesOf(
  layer: PermissionLayerSettings,
  anchor: string,
  home: string
): {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowedDomains: string[];
  deniedDomains: string[];
} {
  const out = {
    allowWrite: [] as string[],
    denyWrite: [] as string[],
    denyRead: [] as string[],
    allowedDomains: [] as string[],
    deniedDomains: [] as string[],
  };
  for (const behavior of ['allow', 'deny'] as const) {
    for (const text of layer[behavior] ?? []) {
      const parsed = parseRule(text);
      if ('error' in parsed || parsed.specifier === undefined) continue;
      if (parsed.tool === 'WebFetch') {
        const domains = ruleDomains(parsed.specifier);
        (behavior === 'allow' ? out.allowedDomains : out.deniedDomains).push(...domains);
        continue;
      }
      const path = rulePath(parsed.specifier, anchor, home);
      if (path === undefined) continue;
      if (parsed.tool === 'Edit' && behavior === 'deny') out.denyWrite.push(path);
      if (parsed.tool === 'Read' && behavior === 'deny') out.denyRead.push(path);
      if (parsed.tool === 'Edit' && behavior === 'allow') {
        const literal = path.replace(/\/\*\*$/, '');
        if (!/[*?[]/.test(literal)) out.allowWrite.push(literal);
      }
    }
  }
  return out;
}

/** Whether `path` is `dir` or lies under it */
function within(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/**
 * The policy the `sandbox` sections of the layers make, as Claude Code merges them: a boolean
 * from the highest layer that sets it (managed, local, project, user), lists combined across the
 * layers with the paths and domains of the `Edit`, `Read` and `WebFetch(domain:...)` rules, and
 * the managed locks applied:
 *
 * - `allowManagedDomainsOnly` (managed) keeps only the managed `allowedDomains` and refuses
 *   other hosts, `allowManagedReadPathsOnly` keeps only the managed `allowRead`
 * - the sandbox is admin-required when managed settings set `allowUnsandboxedCommands: false`
 *   or `allowManagedDomainsOnly`: then a repository's files (project and local) cannot loosen
 *   it (`excludedCommands`, `ignoreViolations`, `allowedDomains`, `allowUnixSockets`,
 *   `allowWrite`, `Edit` allow rules, `additionalDirectories`, a `true` of
 *   `allowLocalBinding` or `allowAllUnixSockets`, a `false` of `enabled` against the user's
 *   `true`, any `false` of `failIfUnavailable`)
 * - `strictAllowlist` counts from user and managed settings, and then a repository's allowed
 *   domains do not count; `filesystem.disabled` from user and managed settings, from managed
 *   ones only once they configure the filesystem; `bwrapPath` and `socatPath` from managed ones
 * - a `false` of `allowUnsandboxedCommands` in user or managed settings holds against a
 *   repository's `true`
 * - a repository's `allowRead`, `allowWrite` and extra directories at or under a path managed
 *   or user settings deny reading are left out
 *
 * Deviations from Claude Code: `failIfUnavailable` defaults to true once `enabled` is, and
 * `allowUnsandboxedCommands` to false
 */
export function sandboxPolicyOf(
  layers: readonly PermissionLayerSettings[],
  options: { home?: string } = {}
): SandboxPolicyResult {
  const home = options.home ?? homedir();
  const warnings: string[] = [];
  const files = layers
    .filter(
      (layer): layer is PermissionLayerSettings & { layer: FileLayer } => layer.layer !== 'session'
    )
    .sort((a, b) => ORDER[a.layer] - ORDER[b.layer]);
  const anchorOf = (layer: PermissionLayerSettings) => layer.anchor ?? process.cwd();
  const isRepo = (layer: PermissionLayerSettings) =>
    layer.layer === 'project' || layer.layer === 'local';
  const managed = files.filter((layer) => layer.layer === 'managed');
  const managedSays = <T>(read: (section: SandboxSettingsFile) => T | undefined): T | undefined =>
    managed
      .map((layer) => (layer.sandbox ? read(layer.sandbox) : undefined))
      .find((v) => v !== undefined);

  const managedRulesOnly = managed.some((layer) => layer.allowManagedPermissionRulesOnly === true);
  const managedDomainsOnly = managedSays((s) => s.network?.allowManagedDomainsOnly) === true;
  const managedReadOnly = managedSays((s) => s.filesystem?.allowManagedReadPathsOnly) === true;
  const adminRequired =
    managedSays((s) => s.allowUnsandboxedCommands) === false || managedDomainsOnly;

  const highest = <T>(
    read: (section: SandboxSettingsFile) => T | undefined,
    accept: (layer: PermissionLayerSettings, value: T) => boolean = () => true
  ): T | undefined => {
    for (const layer of files) {
      const value = layer.sandbox ? read(layer.sandbox) : undefined;
      if (value !== undefined && accept(layer, value)) return value;
    }
    return undefined;
  };
  const userTrue = (read: (section: SandboxSettingsFile) => boolean | undefined) =>
    files.some((layer) => layer.layer === 'user' && layer.sandbox && read(layer.sandbox) === true);
  const notRepoFalse =
    (read: (section: SandboxSettingsFile) => boolean | undefined) =>
    (layer: PermissionLayerSettings, value: boolean) =>
      !(adminRequired && isRepo(layer) && value === false && userTrue(read));
  const notRepoTrue = (layer: PermissionLayerSettings, value: boolean) =>
    !(adminRequired && isRepo(layer) && value === true);

  const enabled =
    highest(
      (s) => s.enabled,
      notRepoFalse((s) => s.enabled)
    ) === true;
  const failIfUnavailable =
    highest(
      (s) => s.failIfUnavailable,
      (layer, value) => !(adminRequired && isRepo(layer) && value === false)
    ) ?? true;
  const autoAllow = highest((s) => s.autoAllowBashIfSandboxed) ?? true;
  const trustedFalse = files.some(
    (layer) =>
      (layer.layer === 'user' || layer.layer === 'managed') &&
      layer.sandbox?.allowUnsandboxedCommands === false
  );
  const allowUnsandboxed = trustedFalse
    ? false
    : (highest((s) => s.allowUnsandboxedCommands) ?? false);

  const trusted = (layer: PermissionLayerSettings) =>
    layer.layer === 'user' || layer.layer === 'managed';
  const strictAllowlist =
    managedDomainsOnly ||
    files.some((layer) => trusted(layer) && layer.sandbox?.network?.strictAllowlist === true);
  for (const layer of files) {
    if (isRepo(layer) && layer.sandbox?.network?.strictAllowlist !== undefined) {
      warnings.push(
        `${layer.origin}: sandbox.network.strictAllowlist counts only from user and managed settings, it is ignored`
      );
    }
  }
  const managedFilesystem = managed.some((layer) => layer.sandbox?.filesystem !== undefined);
  const disabled = highest(
    (s) => s.filesystem?.disabled,
    (layer) => (managedFilesystem ? layer.layer === 'managed' : trusted(layer))
  );
  for (const layer of files) {
    if (layer.sandbox?.filesystem?.disabled === undefined) continue;
    if (managedFilesystem ? layer.layer !== 'managed' : !trusted(layer)) {
      warnings.push(
        `${layer.origin}: sandbox.filesystem.disabled cannot be set here, it is ignored`
      );
    }
  }
  const allowLocalBinding = highest((s) => s.network?.allowLocalBinding, notRepoTrue);
  const allowAllUnixSockets = highest((s) => s.network?.allowAllUnixSockets, notRepoTrue);
  const bwrapPath = managedSays((s) => s.bwrapPath);
  const socatPath = managedSays((s) => s.socatPath);
  for (const layer of files) {
    if (layer.layer === 'managed') continue;
    for (const key of ['bwrapPath', 'socatPath'] as const) {
      if (layer.sandbox?.[key] !== undefined) {
        warnings.push(
          `${layer.origin}: sandbox.${key} counts only from managed settings, it is ignored`
        );
      }
    }
  }

  const lists = {
    excludedCommands: [] as string[],
    allowWrite: [] as string[],
    denyWrite: [] as string[],
    denyRead: [] as string[],
    allowRead: [] as string[],
    allowedDomains: [] as string[],
    deniedDomains: [] as string[],
    allowUnixSockets: [] as string[],
    envVars: [] as string[],
  };
  const ignoreViolations: Record<string, string[]> = {};
  const trustedDenyRead: string[] = [];
  for (const layer of files) {
    if (!trusted(layer)) continue;
    const anchor = anchorOf(layer);
    for (const entry of layer.sandbox?.filesystem?.denyRead ?? []) {
      trustedDenyRead.push(sandboxSettingsPath(entry, anchor, home));
    }
    for (const entry of layer.sandbox?.credentials?.files ?? []) {
      trustedDenyRead.push(sandboxSettingsPath(entry.path, anchor, home));
    }
    if (!managedRulesOnly || layer.layer === 'managed') {
      trustedDenyRead.push(...rulesOf(layer, anchor, home).denyRead);
    }
  }
  const underTrustedDeny = (path: string) =>
    trustedDenyRead.some((denied) => {
      const wildcard = denied.indexOf('/**');
      return within(wildcard === -1 ? denied : denied.slice(0, wildcard), path);
    });

  for (const layer of files) {
    const section = layer.sandbox ?? {};
    const anchor = anchorOf(layer);
    const repo = isRepo(layer);
    const loosensIgnored = adminRequired && repo;
    const path = (entry: string) => sandboxSettingsPath(entry, anchor, home);
    const fromRules =
      managedRulesOnly && layer.layer !== 'managed'
        ? { allowWrite: [], denyWrite: [], denyRead: [], allowedDomains: [], deniedDomains: [] }
        : rulesOf(layer, anchor, home);
    if (!loosensIgnored) {
      lists.excludedCommands.push(...(section.excludedCommands ?? []));
      for (const [key, values] of Object.entries(section.ignoreViolations ?? {})) {
        ignoreViolations[key] = [...(ignoreViolations[key] ?? []), ...values];
      }
      lists.allowUnixSockets.push(...(section.network?.allowUnixSockets ?? []).map(path));
      const writable = [
        ...(section.filesystem?.allowWrite ?? []).map(path),
        ...fromRules.allowWrite,
        ...(layer.additionalDirectories ?? []).map((dir) =>
          isAbsolute(dir) ? dir : resolve(anchor, dir)
        ),
      ];
      lists.allowWrite.push(...writable.filter((entry) => !(repo && underTrustedDeny(entry))));
    }
    const domainsCount =
      !loosensIgnored &&
      (!managedDomainsOnly || layer.layer === 'managed') &&
      !(repo && strictAllowlist);
    if (domainsCount) {
      lists.allowedDomains.push(
        ...(section.network?.allowedDomains ?? []),
        ...fromRules.allowedDomains
      );
    }
    if (!managedReadOnly || layer.layer === 'managed') {
      lists.allowRead.push(
        ...(section.filesystem?.allowRead ?? [])
          .map(path)
          .filter((entry) => !(repo && underTrustedDeny(entry)))
      );
    }
    lists.denyWrite.push(
      ...(section.filesystem?.denyWrite ?? []).map(path),
      ...fromRules.denyWrite
    );
    lists.denyRead.push(
      ...(section.filesystem?.denyRead ?? []).map(path),
      ...fromRules.denyRead,
      ...(section.credentials?.files ?? []).map((entry) => path(entry.path))
    );
    lists.deniedDomains.push(...(section.network?.deniedDomains ?? []), ...fromRules.deniedDomains);
    lists.envVars.push(...(section.credentials?.envVars ?? []).map((entry) => entry.name));
  }
  const unique = (values: readonly string[]) => [...new Set(values)];

  const policy: OsSandboxPolicy & { enabled: boolean } = {
    enabled,
    failIfUnavailable,
    autoAllow,
    allowUnsandboxed,
    excludedCommands: unique(lists.excludedCommands),
    ...(Object.keys(ignoreViolations).length > 0 && { ignoreViolations }),
    filesystem: {
      allowWrite: unique(lists.allowWrite),
      denyWrite: unique(lists.denyWrite),
      denyRead: unique(lists.denyRead),
      allowRead: unique(lists.allowRead),
      ...(disabled !== undefined && { disabled }),
    },
    network: {
      allowedDomains: unique(lists.allowedDomains),
      deniedDomains: unique(lists.deniedDomains),
      strictAllowlist,
      ...(allowLocalBinding !== undefined && { allowLocalBinding }),
      allowUnixSockets: unique(lists.allowUnixSockets),
      ...(allowAllUnixSockets !== undefined && { allowAllUnixSockets }),
    },
    ...(lists.envVars.length > 0 && { credentials: { envVars: unique(lists.envVars) } }),
    ...(bwrapPath !== undefined && { bwrapPath }),
    ...(socatPath !== undefined && { socatPath }),
  };
  return { policy, warnings };
}

/**
 * The `sandbox` section of an untrusted project's file without what loosens the sandbox: only its
 * denies and the settings that tighten it count
 */
export function untrustedSandbox(section: SandboxSettingsFile): SandboxSettingsFile {
  const kept: SandboxSettingsFile = {};
  if (section.enabled === true) kept.enabled = true;
  if (section.failIfUnavailable === true) kept.failIfUnavailable = true;
  if (section.autoAllowBashIfSandboxed === false) kept.autoAllowBashIfSandboxed = false;
  if (section.allowUnsandboxedCommands === false) kept.allowUnsandboxedCommands = false;
  if (section.filesystem?.denyWrite || section.filesystem?.denyRead) {
    kept.filesystem = {
      ...(section.filesystem.denyWrite && { denyWrite: section.filesystem.denyWrite }),
      ...(section.filesystem.denyRead && { denyRead: section.filesystem.denyRead }),
    };
  }
  const network = section.network;
  if (
    network?.deniedDomains ||
    network?.allowLocalBinding === false ||
    network?.allowAllUnixSockets === false
  ) {
    kept.network = {
      ...(network.deniedDomains && { deniedDomains: network.deniedDomains }),
      ...(network.allowLocalBinding === false && { allowLocalBinding: false }),
      ...(network.allowAllUnixSockets === false && { allowAllUnixSockets: false }),
    };
  }
  if (section.credentials) kept.credentials = section.credentials;
  return kept;
}
