/**
 * Where installed plugins are kept, in the layout of Claude Code's `~/.claude/plugins`:
 * `cache/<marketplace>/<plugin>/<version>/` for each installed version, `data/<id>/` for what a
 * plugin keeps across updates, `marketplaces/<name>/` for fetched marketplaces, and the records
 * `installed_plugins.json` and `known_marketplaces.json`
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { InstalledPluginRecord, KnownMarketplace } from '@cogitator-ai/types';
import { marketplaceSourceSchema } from './settings';

export const INSTALLED_PLUGINS_FILE = 'installed_plugins.json';
export const KNOWN_MARKETPLACES_FILE = 'known_marketplaces.json';

/** The folder of installed plugins: `COGITATOR_PLUGINS_DIR`, else `~/.cogitator/plugins` */
export function defaultPluginsRoot(): string {
  const configured = process.env.COGITATOR_PLUGINS_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), '.cogitator', 'plugins');
}

/**
 * The id as a folder name, one per id: the id with every character but letters, digits, `_` and
 * `-` turned into `-` (as Claude Code names it, for a person to recognize), then `-` and the first
 * 16 hex digits of the SHA-256 of the whole id. Ids the readable part alone would merge
 * (`foo-bar@baz` and `foo@bar-baz`, or two that differ only in case on a filesystem that ignores
 * it) get folders of their own
 */
export function pluginIdFolder(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9_-]/g, '-');
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 16);
  return `${readable}-${digest}`;
}

/** `${CLAUDE_PLUGIN_DATA}` of the plugin `id` */
export function pluginDataDir(root: string, id: string): string {
  return join(root, 'data', pluginIdFolder(id));
}

const PermissionsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

const SourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('path'), path: z.string() }),
  z.object({
    source: z.literal('github'),
    repo: z.string(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('git-subdir'),
    url: z.string(),
    path: z.string(),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('npm'),
    package: z.string(),
    version: z.string().optional(),
    registry: z.string().optional(),
  }),
  z.object({ source: z.literal('archive'), url: z.string(), sha256: z.string().optional() }),
  z.object({
    source: z.literal('command'),
    command: z.string(),
    timeout: z.number().optional(),
    mode: z.enum(['copy', 'link']).optional(),
  }),
]);

const RecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  marketplace: z.string(),
  version: z.string(),
  installPath: z.string(),
  source: SourceSchema,
  pin: z.object({
    commit: z.string().optional(),
    npmVersion: z.string().optional(),
    integrity: z.string().optional(),
    sha256: z.string().optional(),
  }),
  entry: z.record(z.string(), z.unknown()).optional(),
  grantedPermissions: PermissionsSchema.optional(),
  dependency: z.boolean().optional(),
  installedAt: z.string(),
  lastUpdated: z.string(),
});

const InstalledFileSchema = z.object({
  version: z.literal(1),
  plugins: z.record(z.string(), z.unknown()),
});

const MarketplaceRecordSchema = z.object({
  name: z.string(),
  source: marketplaceSourceSchema,
  installLocation: z.string(),
  commit: z.string().optional(),
  lastUpdated: z.string(),
});

const KnownFileSchema = z.object({
  version: z.literal(1),
  marketplaces: z.record(z.string(), z.unknown()),
});

/** The installed plugins of `root`, and what was wrong with the record */
export async function readInstalledPlugins(
  root: string
): Promise<{ records: InstalledPluginRecord[]; warnings: string[] }> {
  const file = join(root, INSTALLED_PLUGINS_FILE);
  const warnings: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], warnings };
    warnings.push(
      `${file} could not be read (${error instanceof Error ? error.message : String(error)}), no installed plugin loads`
    );
    return { records: [], warnings };
  }
  const parsed = InstalledFileSchema.safeParse(json);
  if (!parsed.success) {
    warnings.push(`${file} is not a record of installed plugins, no installed plugin loads`);
    return { records: [], warnings };
  }
  const records: InstalledPluginRecord[] = [];
  for (const [id, value] of Object.entries(parsed.data.plugins)) {
    const record = RecordSchema.safeParse(value);
    if (!record.success || record.data.id !== id) {
      warnings.push(`${file}: the record of ${id} is not valid, the plugin does not load`);
      continue;
    }
    records.push(record.data as InstalledPluginRecord);
  }
  return { records, warnings };
}

async function writeJson(file: string, json: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(json, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, file);
}

/** Writes the installed plugins of `root` */
export async function writeInstalledPlugins(
  root: string,
  records: readonly InstalledPluginRecord[]
): Promise<void> {
  await writeJson(join(root, INSTALLED_PLUGINS_FILE), {
    version: 1,
    plugins: Object.fromEntries(records.map((record) => [record.id, record])),
  });
}

/** The marketplaces `root` knows, and what was wrong with their record */
export async function readKnownMarketplaces(
  root: string
): Promise<{ marketplaces: KnownMarketplace[]; warnings: string[] }> {
  const file = join(root, KNOWN_MARKETPLACES_FILE);
  const warnings: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { marketplaces: [], warnings };
    warnings.push(
      `${file} could not be read (${error instanceof Error ? error.message : String(error)})`
    );
    return { marketplaces: [], warnings };
  }
  const parsed = KnownFileSchema.safeParse(json);
  if (!parsed.success) {
    warnings.push(`${file} is not a record of marketplaces`);
    return { marketplaces: [], warnings };
  }
  const marketplaces: KnownMarketplace[] = [];
  for (const [name, value] of Object.entries(parsed.data.marketplaces)) {
    const record = MarketplaceRecordSchema.safeParse(value);
    if (!record.success || record.data.name !== name) {
      warnings.push(`${file}: the record of marketplace ${name} is not valid, it is ignored`);
      continue;
    }
    marketplaces.push(record.data);
  }
  return { marketplaces, warnings };
}

/** Writes the marketplaces `root` knows */
export async function writeKnownMarketplaces(
  root: string,
  marketplaces: readonly KnownMarketplace[]
): Promise<void> {
  await writeJson(join(root, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces: Object.fromEntries(
      marketplaces.map((marketplace) => [marketplace.name, marketplace])
    ),
  });
}
