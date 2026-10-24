/**
 * Reading permission rules from Claude Code compatible settings files, and saving the rules an
 * "always allow" answer adds
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  PERMISSION_MODES,
  type PermissionLayer,
  type PermissionLayerSettings,
  type PermissionRememberLayer,
  type PermissionSettingsOptions,
} from '@cogitator-ai/types';

type FileLayer = Exclude<PermissionLayer, 'session'>;

/** The settings files of the permission rules, by layer, as {@link loadPermissionSettings} reads them */
export interface PermissionSettingsPlaces {
  managed: string[];
  user: string[];
  project: string[];
  local: string[];
}

/** Directories of the managed files of the platform: Cogitator's first, then Claude Code's */
export function defaultManagedDirs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    return ['/Library/Application Support/Cogitator', '/Library/Application Support/ClaudeCode'];
  }
  if (platform === 'win32') {
    return ['C:\\Program Files\\Cogitator', 'C:\\Program Files\\ClaudeCode'];
  }
  return ['/etc/cogitator', '/etc/claude-code'];
}

/** Directories of the user files: `~/.cogitator`, then `CLAUDE_CONFIG_DIR` or `~/.claude` */
export function defaultUserDirs(): string[] {
  const home = homedir();
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim();
  return [join(home, '.cogitator'), claude ? resolve(claude) : join(home, '.claude')];
}

const RULES = z.array(z.unknown()).optional();

const PermissionsSchema = z.looseObject({
  allow: RULES,
  ask: RULES,
  deny: RULES,
  defaultMode: z.unknown().optional(),
  disableBypassPermissionsMode: z.unknown().optional(),
  disableAutoMode: z.unknown().optional(),
  allowManagedPermissionRulesOnly: z.unknown().optional(),
  additionalDirectories: RULES,
});

/** What a loader found: the layers, and the problems of the files it read */
export interface LoadedPermissionSettings {
  layers: PermissionLayerSettings[];
  warnings: string[];
  /** Every file it looked at, with the time it changed (0 for a missing one) */
  files: Map<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function changedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** `settings.json` or `managed-settings.json` and the `*.json` of a drop-in directory, in order */
async function managedFilesOf(dir: string): Promise<string[]> {
  const files = [join(dir, 'managed-settings.json')];
  try {
    const dropIns = (await readdir(join(dir, 'managed-settings.d')))
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort();
    files.push(...dropIns.map((name) => join(dir, 'managed-settings.d', name)));
  } catch {
    return files;
  }
  return files;
}

/** Where {@link loadPermissionSettings} looks for each layer's files, for `root` */
export async function permissionSettingsPlaces(
  root: string,
  options: PermissionSettingsOptions = {}
): Promise<PermissionSettingsPlaces> {
  const managedDirs = options.managedDirs ?? defaultManagedDirs();
  const managed = (await Promise.all(managedDirs.map(managedFilesOf))).flat();
  return {
    managed,
    user: (options.userDirs ?? defaultUserDirs()).map((dir) => join(dir, 'settings.json')),
    project: [join(root, '.claude', 'settings.json'), join(root, '.cogitator', 'settings.json')],
    local: [
      join(root, '.claude', 'settings.local.json'),
      join(root, '.cogitator', 'settings.local.json'),
    ],
  };
}

function stringsOf(
  value: unknown[] | undefined,
  field: string,
  origin: string,
  warnings: string[]
): string[] | undefined {
  if (value === undefined) return undefined;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') strings.push(entry);
    else
      warnings.push(`${origin}: an entry of permissions.${field} is not a string, it is ignored`);
  }
  return strings;
}

/** The `permissions` of one settings file as a layer, problems with it in `warnings` */
export function readPermissionLayer(
  json: unknown,
  layer: FileLayer,
  origin: string,
  anchor: string,
  warnings: string[]
): PermissionLayerSettings | undefined {
  if (!isRecord(json)) {
    warnings.push(`${origin}: the file does not hold a JSON object, it is ignored`);
    return undefined;
  }
  const raw = json.permissions;
  if (raw === undefined) return undefined;
  const parsed = PermissionsSchema.safeParse(raw);
  if (!parsed.success) {
    warnings.push(`${origin}: permissions is not an object of lists, it is ignored`);
    return undefined;
  }
  const value = parsed.data;
  const settings: PermissionLayerSettings = { layer, origin, anchor };
  const allow = stringsOf(value.allow, 'allow', origin, warnings);
  const ask = stringsOf(value.ask, 'ask', origin, warnings);
  const deny = stringsOf(value.deny, 'deny', origin, warnings);
  const directories = stringsOf(
    value.additionalDirectories,
    'additionalDirectories',
    origin,
    warnings
  );
  if (allow) settings.allow = allow;
  if (ask) settings.ask = ask;
  if (deny) settings.deny = deny;
  if (directories) settings.additionalDirectories = directories;
  const mode = value.defaultMode === 'manual' ? 'default' : value.defaultMode;
  if (mode !== undefined) {
    const known = PERMISSION_MODES.find((candidate) => candidate === mode);
    if (!known) {
      warnings.push(
        `${origin}: permissions.defaultMode "${String(mode)}" is not a mode Cogitator has, it is ignored`
      );
    } else if (
      (layer === 'project' || layer === 'local') &&
      (known === 'auto' || known === 'bypassPermissions')
    ) {
      warnings.push(
        `${origin}: permissions.defaultMode "${known}" takes effect only from user or managed settings, it is ignored`
      );
    } else {
      settings.defaultMode = known;
    }
  }
  if (value.disableBypassPermissionsMode === 'disable')
    settings.disableBypassPermissionsMode = 'disable';
  if (value.disableAutoMode === 'disable') settings.disableAutoMode = 'disable';
  if (layer === 'managed' && value.allowManagedPermissionRulesOnly === true) {
    settings.allowManagedPermissionRulesOnly = true;
  }
  return settings;
}

/** An untrusted project's file, without what grants: its allow rules, extra directories and mode */
function untrusted(settings: PermissionLayerSettings): PermissionLayerSettings {
  const { allow: _allow, additionalDirectories: _dirs, defaultMode: _mode, ...rest } = settings;
  return rest;
}

/**
 * Reads the permission rules of the settings files for the project at `root`, each file a layer of
 * its own: managed (`managed-settings.json` and `managed-settings.d/*.json` of Cogitator's and
 * Claude Code's system directories), user (`~/.cogitator/settings.json`, `~/.claude/settings.json`),
 * project (`.claude/settings.json`, `.cogitator/settings.json`) and local
 * (`.claude/settings.local.json`, `.cogitator/settings.local.json`). A missing file is skipped, one
 * that is not JSON is skipped with a warning, as are entries that are not rules
 */
export async function loadPermissionSettings(
  root: string,
  options: PermissionSettingsOptions = {}
): Promise<LoadedPermissionSettings> {
  const places = await permissionSettingsPlaces(root, options);
  const wanted = new Set<FileLayer>(options.layers ?? ['managed', 'user', 'project', 'local']);
  const warnings: string[] = [];
  const files = new Map<string, number>();
  const layers: PermissionLayerSettings[] = [];
  for (const layer of ['managed', 'local', 'project', 'user'] as const) {
    if (!wanted.has(layer)) continue;
    for (const file of places[layer]) {
      files.set(file, await changedAt(file));
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        warnings.push(
          `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}), it is ignored`
        );
        continue;
      }
      const anchor = layer === 'project' || layer === 'local' ? root : dirname(file);
      const settings = readPermissionLayer(json, layer, file, anchor, warnings);
      if (!settings) continue;
      layers.push(
        layer === 'project' && options.trusted === false ? untrusted(settings) : settings
      );
    }
  }
  return { layers, warnings, files };
}

/** The file an "always allow" rule of `layer` is saved to */
export function rememberFile(
  layer: Exclude<PermissionRememberLayer, 'session'>,
  root: string,
  options: PermissionSettingsOptions = {}
): string {
  if (layer === 'user') return join((options.userDirs ?? defaultUserDirs())[0], 'settings.json');
  return join(root, '.cogitator', layer === 'local' ? 'settings.local.json' : 'settings.json');
}

const writes = new Map<string, Promise<void>>();

/**
 * Adds `rule` to the `permissions.allow` of the settings file `file`, creating it when missing and
 * keeping everything else it holds. Saves of one file go one after another
 */
export function addAllowRule(file: string, rule: string): Promise<void> {
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeAllowRule(file, rule));
  writes.set(file, next);
  void next
    .finally(() => {
      if (writes.get(file) === next) writes.delete(file);
    })
    .catch(() => undefined);
  return next;
}

async function writeAllowRule(file: string, rule: string): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error(`${file} does not hold a JSON object`);
    json = { ...parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const permissions = isRecord(json.permissions) ? { ...json.permissions } : {};
  const allow: unknown[] = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  if (allow.includes(rule)) return;
  permissions.allow = [...allow, rule];
  json.permissions = permissions;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/** Whether any of `files` changed since it was read */
export async function settingsChanged(files: ReadonlyMap<string, number>): Promise<boolean> {
  for (const [file, time] of files) {
    if ((await changedAt(file)) !== time) return true;
  }
  return false;
}
