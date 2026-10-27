/**
 * The plugin keys of Claude Code compatible settings files: `enabledPlugins`, `pluginConfigs` and
 * `extraKnownMarketplaces`, in the layers and with the trust of the hooks
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  MarketplaceSource,
  PermissionLayer,
  PluginOptionValue,
  PluginSettingsOptions,
} from '@cogitator-ai/types';
import { defaultUserDirs, permissionSettingsPlaces } from '../permissions/settings';
import { trustsProject } from '../hooks/settings';
import { dictionary } from '../utils/own';

/** Where a plugin's `enabledPlugins` value came from */
export interface EnabledEntry {
  value: boolean;
  layer: PermissionLayer;
  /** The settings file, `code` for `experimental_plugins.enabled` */
  source: string;
}

/** A marketplace a settings file declares */
export interface DeclaredMarketplace {
  name: string;
  source: MarketplaceSource;
  autoUpdate?: boolean;
  layer: PermissionLayer;
  file: string;
}

/** The plugin keys of every settings layer, read once */
export interface PluginSettings {
  /** For each plugin id, the value of the highest layer that names it */
  enabled: ReadonlyMap<string, EnabledEntry>;
  /** Option values of `pluginConfigs`, by plugin id: the managed files over the user's */
  options: Readonly<Record<string, Readonly<Record<string, PluginOptionValue>>>>;
  marketplaces: readonly DeclaredMarketplace[];
  warnings: readonly string[];
}

const OptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const PluginConfigsSchema = z.record(
  z.string(),
  z.looseObject({ options: z.record(z.string(), OptionValueSchema).optional() })
);

const MarketplaceSourceSchema: z.ZodType<MarketplaceSource> = z.union([
  z.strictObject({
    source: z.literal('github'),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    ref: z.string().optional(),
    path: z.string().optional(),
    sparsePaths: z.array(z.string()).optional(),
    skipLfs: z.boolean().optional(),
  }),
  z.strictObject({
    source: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().optional(),
    path: z.string().optional(),
    sparsePaths: z.array(z.string()).optional(),
    skipLfs: z.boolean().optional(),
  }),
  z.strictObject({
    source: z.literal('url'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({ source: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({ source: z.literal('directory'), path: z.string().min(1) }),
]) as z.ZodType<MarketplaceSource>;

/** A marketplace source as settings and `known_marketplaces.json` write it */
export const marketplaceSourceSchema = MarketplaceSourceSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Layers from the highest: managed, then code (`session`), local, project, user */
const ORDER: readonly Exclude<PermissionLayer, 'session'>[] = [
  'managed',
  'local',
  'project',
  'user',
];

/**
 * Reads the plugin keys of the settings files of `root` (`options` unset reads none). A project's
 * own files (`project`, `local`) count only once the project is trusted, as for hooks. `code`
 * values of `experimental_plugins.enabled` sit between the managed files and the others
 */
export async function loadPluginSettings(
  root: string,
  options: PluginSettingsOptions | undefined,
  code: { enabled?: Readonly<Record<string, boolean>>; options?: PluginSettings['options'] } = {}
): Promise<PluginSettings> {
  const warnings: string[] = [];
  const enabled = new Map<string, EnabledEntry>();
  const managedOptions: Record<string, Record<string, PluginOptionValue>> = dictionary();
  const userOptions: Record<string, Record<string, PluginOptionValue>> = dictionary();
  const marketplaces: DeclaredMarketplace[] = [];
  const files: {
    layer: Exclude<PermissionLayer, 'session'>;
    file: string;
    json: Record<string, unknown>;
  }[] = [];
  if (options) {
    const places = await permissionSettingsPlaces(root, options);
    const wanted = new Set(options.layers ?? ['managed', 'user', 'project', 'local']);
    const trusted = trustsProject(options, root);
    for (const layer of ORDER) {
      if (!wanted.has(layer)) continue;
      for (const file of places[layer]) {
        const json = await readJson(file, warnings);
        if (!json) continue;
        const mentions =
          json.enabledPlugins !== undefined ||
          json.extraKnownMarketplaces !== undefined ||
          json.pluginConfigs !== undefined;
        if ((layer === 'project' || layer === 'local') && !trusted) {
          if (mentions) {
            warnings.push(
              `${file}: the project ${root} is not trusted, its plugin settings are ignored (trust it with experimental_plugins.settings.trusted and root, or trustedRoots)`
            );
          }
          continue;
        }
        files.push({ layer, file, json });
      }
    }
  }
  const take = (id: string, entry: EnabledEntry) => {
    if (!enabled.has(id)) enabled.set(id, entry);
  };
  for (const { layer, file, json } of files.filter((entry) => entry.layer === 'managed')) {
    readEnabled(json, file, warnings, (id, value) => take(id, { value, layer, source: file }));
  }
  for (const [id, value] of Object.entries(code.enabled ?? {})) {
    take(id, { value, layer: 'session', source: 'code' });
  }
  for (const { layer, file, json } of files.filter((entry) => entry.layer !== 'managed')) {
    readEnabled(json, file, warnings, (id, value) => take(id, { value, layer, source: file }));
  }
  for (const { layer, file, json } of files) {
    if (json.pluginConfigs !== undefined && (layer === 'managed' || layer === 'user')) {
      const parsed = PluginConfigsSchema.safeParse(json.pluginConfigs);
      if (!parsed.success) {
        warnings.push(
          `${file}: pluginConfigs is not a map of plugin ids to { options }, it is ignored`
        );
      } else {
        const target = layer === 'managed' ? managedOptions : userOptions;
        for (const [id, entry] of Object.entries(parsed.data)) {
          target[id] = { ...(target[id] ?? {}), ...(entry.options ?? {}) };
        }
      }
    }
    if (json.extraKnownMarketplaces !== undefined) {
      if (!isRecord(json.extraKnownMarketplaces)) {
        warnings.push(`${file}: extraKnownMarketplaces is not an object, it is ignored`);
        continue;
      }
      for (const [name, entry] of Object.entries(json.extraKnownMarketplaces)) {
        const source = isRecord(entry)
          ? MarketplaceSourceSchema.safeParse(entry.source)
          : undefined;
        if (!source?.success) {
          warnings.push(
            `${file}: extraKnownMarketplaces.${name} has no valid source, it is ignored`
          );
          continue;
        }
        marketplaces.push({
          name,
          source: source.data,
          ...(isRecord(entry) &&
            typeof entry.autoUpdate === 'boolean' && { autoUpdate: entry.autoUpdate }),
          layer,
          file,
        });
      }
    }
  }
  const merged: Record<string, Record<string, PluginOptionValue>> = dictionary();
  for (const source of [userOptions, code.options ?? {}, managedOptions]) {
    for (const [id, values] of Object.entries(source))
      merged[id] = { ...(merged[id] ?? {}), ...values };
  }
  return { enabled, options: merged, marketplaces, warnings };
}

function readEnabled(
  json: Record<string, unknown>,
  file: string,
  warnings: string[],
  take: (id: string, value: boolean) => void
): void {
  if (json.enabledPlugins === undefined) return;
  if (!isRecord(json.enabledPlugins)) {
    warnings.push(`${file}: enabledPlugins is not an object, it is ignored`);
    return;
  }
  for (const [id, value] of Object.entries(json.enabledPlugins)) {
    if (typeof value !== 'boolean') {
      warnings.push(`${file}: enabledPlugins.${id} is not true or false, it is ignored`);
      continue;
    }
    take(id, value);
  }
}

async function readJson(
  file: string,
  warnings: string[]
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const json: unknown = JSON.parse(text);
    if (isRecord(json)) return json;
    warnings.push(`${file}: the file does not hold a JSON object, it is ignored`);
  } catch (error) {
    warnings.push(
      `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}), it is ignored`
    );
  }
  return undefined;
}

/** Which settings file a scope writes: the user's, the project's shared one or its local one */
export type PluginSettingsScope = 'user' | 'project' | 'local';

/** The Cogitator settings file of `scope` */
export function pluginSettingsFile(
  scope: PluginSettingsScope,
  root: string,
  options: Pick<PluginSettingsOptions, 'userDirs'> = {}
): string {
  if (scope === 'user') {
    return join(
      (options.userDirs ?? defaultUserDirs())[0] ?? join(root, '.cogitator'),
      'settings.json'
    );
  }
  return join(root, '.cogitator', scope === 'local' ? 'settings.local.json' : 'settings.json');
}

const writes = new Map<string, Promise<void>>();

/**
 * Changes the settings file `file` with `change`, creating it when missing and keeping what else
 * it holds. Changes of one file go one after another, each written to a temporary file and moved
 * into place
 */
export function updateSettingsFile(
  file: string,
  change: (json: Record<string, unknown>) => void
): Promise<void> {
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      let json: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!isRecord(parsed)) throw new Error(`${file} does not hold a JSON object`);
        json = { ...parsed };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      change(json);
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    });
  writes.set(file, next);
  void next
    .finally(() => {
      if (writes.get(file) === next) writes.delete(file);
    })
    .catch(() => undefined);
  return next;
}

/** Sets (or with `undefined` removes) the `enabledPlugins` entry of `id` in `file` */
export function writeEnabledPlugin(
  file: string,
  id: string,
  value: boolean | undefined
): Promise<void> {
  return updateSettingsFile(file, (json) => {
    const entries = isRecord(json.enabledPlugins) ? { ...json.enabledPlugins } : {};
    if (value === undefined) delete entries[id];
    else entries[id] = value;
    if (Object.keys(entries).length === 0) delete json.enabledPlugins;
    else json.enabledPlugins = entries;
  });
}

/** Sets (or with `undefined` removes) option values of `id` under `pluginConfigs` of `file` */
export function writePluginOptions(
  file: string,
  id: string,
  values: Readonly<Record<string, PluginOptionValue | undefined>> | undefined
): Promise<void> {
  return updateSettingsFile(file, (json) => {
    const configs = isRecord(json.pluginConfigs) ? { ...json.pluginConfigs } : {};
    if (values === undefined) {
      delete configs[id];
    } else {
      const entry = isRecord(configs[id]) ? { ...configs[id] } : {};
      const current = isRecord(entry.options) ? { ...entry.options } : {};
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete current[key];
        else current[key] = value;
      }
      entry.options = current;
      configs[id] = entry;
    }
    if (Object.keys(configs).length === 0) delete json.pluginConfigs;
    else json.pluginConfigs = configs;
  });
}
