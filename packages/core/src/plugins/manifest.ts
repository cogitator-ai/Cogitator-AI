/**
 * Reading a plugin folder as Claude Code does: its `.claude-plugin/plugin.json` (optional), the
 * Cogitator extension `.cogitator-plugin/plugin.json` over it, the marketplace entry that stands
 * in for or adds to them, and where each kind of component is
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  HookSettings,
  MarketplacePluginEntry,
  PluginCommandEntry,
  PluginDependency,
  PluginDiagnostic,
  PluginManifest,
  PluginMcpServerConfig,
  PluginOptionSpec,
  PluginPanelSpec,
} from '@cogitator-ai/types';
import { parseCommandFile, parseSubagentFile } from '../subagents/definitions';
import { parseSkillFile } from '../skills/frontmatter';
import { isValidRange } from './semver';

/** Claude Code's manifest, relative to the plugin root */
export const CLAUDE_MANIFEST = join('.claude-plugin', 'plugin.json');

/** Cogitator's extension of it */
export const COGITATOR_MANIFEST = join('.cogitator-plugin', 'plugin.json');

/** Largest manifest, hooks or MCP file read */
const MAX_JSON_BYTES = 1024 * 1024;

/** Most Markdown files read from one component folder */
const MAX_COMPONENT_FILES = 500;

const BIDI = /[‪-‮⁦-⁩‎‏؜]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why `name` cannot name a plugin, undefined when it can */
export function pluginNameProblem(name: string): string | undefined {
  if (name.trim() === '') return 'is empty';
  if (/\s/.test(name)) return 'holds spaces, use kebab-case';
  if (name.includes('@')) return 'holds "@", which separates the plugin from its marketplace';
  if (name.includes(':')) return 'holds ":", which separates the plugin from its components';
  if (name.includes('/') || name.includes('\\')) return 'holds a path separator';
  if (CONTROL.test(name) || BIDI.test(name)) {
    return 'holds a control or bidirectional-formatting character';
  }
  if (name === '.' || name === '..') return 'is not a name';
  return undefined;
}

/** Whether `name` is kebab-case, as Claude Code recommends */
export function isKebabCase(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** Why `name` cannot name a marketplace, undefined when it can */
export function marketplaceNameProblem(name: string): string | undefined {
  if (name === '') return 'is empty';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return 'may only hold letters, digits, ".", "_" and "-", starting with a letter or digit';
  }
  if (RESERVED_MARKETPLACES.has(name.toLowerCase())) {
    return 'is reserved for plugins that do not come from a marketplace';
  }
  if (JS_MEMBERS.has(name)) return 'is a name every JavaScript object has';
  return undefined;
}

/**
 * Marketplace names Claude Code reserves for plugins that come from elsewhere (`npm`, `github` and
 * `git` name plugins installed straight from a package or a repository here)
 */
export const RESERVED_MARKETPLACES: ReadonlySet<string> = new Set([
  'inline',
  'builtin',
  'skills-dir',
  'synced',
  'claude-plugin-test',
  'npm',
  'pip',
  'uv',
  'cargo',
  'github',
  'gh',
  'git',
  'code',
  'core',
]);

const JS_MEMBERS = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__proto__',
]);

/** Names of Anthropic's own marketplaces, which only a repository under `anthropics/` may use */
export const OFFICIAL_MARKETPLACES: ReadonlySet<string> = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'anthropic-agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
  'claude-for-legal',
  'claude-for-financial-services',
  'financial-services-plugins',
  'first-party-plugins',
  'claude-tag-plugins',
  'claude-community',
  'claude-plugins-community',
  'healthcare',
  'anthropic-plugin-directory',
  'claude-plugin-directory',
]);

const OptionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const OptionSchema = z
  .strictObject({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string(),
    description: z.string(),
    required: z.boolean().optional(),
    default: OptionValueSchema.optional(),
    options: z.array(z.string().min(1).max(64)).min(1).optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine((option, context) => {
    if (option.options !== undefined) {
      if (option.type !== 'string' || option.multiple === true || option.sensitive === true) {
        context.addIssue({
          code: 'custom',
          message: 'options applies only to a string that is neither multiple nor sensitive',
        });
      } else if (typeof option.default === 'string' && !option.options.includes(option.default)) {
        context.addIssue({ code: 'custom', message: 'default must be one of options' });
      }
    }
  });

const DependencySchema = z.union([
  z.string().min(1),
  z.strictObject({
    name: z.string().min(1),
    marketplace: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  }),
]);

const PathsSchema = z.union([z.string(), z.array(z.string())]);

const CommandEntrySchema = z.strictObject({
  source: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

const JsonObjectSchema = z.record(z.string(), z.unknown());

const PanelSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'may only hold letters, digits, "-" and "_"'),
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  entry: z.string(),
});

/** The fields of Claude Code's manifest Cogitator reads, each checked on its own */
const CLAUDE_FIELDS = {
  name: z.string(),
  displayName: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.looseObject({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
  homepage: z.url(),
  repository: z.string(),
  license: z.string(),
  keywords: z.array(z.string()),
  defaultEnabled: z.boolean(),
  dependencies: z.array(DependencySchema),
  settings: JsonObjectSchema,
  userConfig: z.record(z.string(), OptionSchema),
  skills: PathsSchema,
  commands: z.union([PathsSchema, z.record(z.string(), CommandEntrySchema)]),
  agents: PathsSchema,
  hooks: z.union([z.string(), JsonObjectSchema, z.array(z.union([z.string(), JsonObjectSchema]))]),
  mcpServers: z.union([
    z.string(),
    JsonObjectSchema,
    z.array(z.union([z.string(), JsonObjectSchema])),
  ]),
} as const;

/** Fields Cogitator's extension adds */
const COGITATOR_FIELDS = {
  main: z.string(),
  ui: z.strictObject({ panels: z.array(PanelSchema).optional() }),
  permissions: z.strictObject({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }),
  engines: z.looseObject({ cogitator: z.string().optional() }),
} as const;

/** Claude Code fields Cogitator knows and does not apply: read without a warning beyond a note */
const UNAPPLIED_FIELDS = new Set([
  'lspServers',
  'outputStyles',
  'workflows',
  'experimental',
  'channels',
  'types',
  'themes',
  'monitors',
]);

/** Claude Code fields only listings read */
const LISTING_FIELDS = new Set([
  '$schema',
  'metadata',
  'icon',
  'documentationUrl',
  'supportUrl',
  'privacyPolicyUrl',
  'termsOfServiceUrl',
]);

/** Fields of a marketplace entry that are not manifest fields */
const ENTRY_FIELDS = new Set([
  'source',
  'category',
  'tags',
  'strict',
  'relevance',
  'headers',
  'headersHelper',
]);

/** The component fields an entry may add to a manifest, as Claude Code's `strict` mode names them */
const ENTRY_COMPONENTS = ['commands', 'agents', 'skills', 'hooks'] as const;

/** A Markdown file of a component, with the name it gives */
export interface ComponentFile {
  path: string;
  /** The name under the plugin: `deploy`, `db:migrate`, `review:security` */
  name: string;
}

/** A command the manifest defines inline */
export interface InlineCommand {
  name: string;
  content: string;
  entry: PluginCommandEntry;
}

/** Hooks of a file or the manifest, and where they came from */
export interface HookSource {
  hooks: HookSettings;
  source: string;
}

/** Where every component of a plugin folder is, read from its manifest and its default folders */
export interface PluginLayout {
  /** The plugin folder, its real path */
  root: string;
  manifest: PluginManifest;
  /** `cogitator` when `.cogitator-plugin/plugin.json` is there */
  format: 'claude' | 'cogitator';
  /** Folders whose skill folders (or which as a skill folder) the plugin has */
  skillDirs: string[];
  /** A `SKILL.md` at the root that makes the plugin one skill, named after the plugin */
  rootSkill: boolean;
  commandFiles: ComponentFile[];
  inlineCommands: InlineCommand[];
  agentFiles: ComponentFile[];
  hooks: HookSource[];
  mcpServers: Record<string, PluginMcpServerConfig>;
  /** The ES module of the plugin's code, its absolute path */
  main?: string;
  panels: { spec: PluginPanelSpec; path: string }[];
  diagnostics: PluginDiagnostic[];
  /** Errors in the manifest itself, each of which keeps the plugin from loading */
  fatal: string[];
}

/** What reading a plugin folder needs besides the folder */
export interface ReadPluginOptions {
  /** The marketplace entry the plugin was installed from, which stands in for a missing manifest */
  entry?: MarketplacePluginEntry;
  /** The name of a plugin without a manifest and an entry (default the folder's name) */
  fallbackName?: string;
  /** The id diagnostics name */
  id?: string;
}

type Report = (level: PluginDiagnostic['level'], message: string, path?: string) => void;

/**
 * Reads the plugin at `dir`: the manifest it has (or the entry, or none), every component path
 * checked to start with `./`, exist and stay inside the folder. Problems go to `diagnostics`: an
 * error in the manifest leaves `manifest` holding only what could be read, an error with a
 * component leaves that component out, as Claude Code does
 */
export async function readPluginLayout(
  dir: string,
  options: ReadPluginOptions = {}
): Promise<PluginLayout> {
  const root = await realpath(resolve(dir));
  const diagnostics: PluginDiagnostic[] = [];
  const report: Report = (level, message, path) =>
    diagnostics.push({
      level,
      message,
      ...(options.id !== undefined && { plugin: options.id }),
      ...(path !== undefined && { path }),
    });
  const fatal: string[] = [];
  const manifestReport: Report = (level, message, path) => {
    report(level, message, path);
    if (level === 'error') fatal.push(message);
  };
  const claudeFile = join(root, CLAUDE_MANIFEST);
  const cogitatorFile = join(root, COGITATOR_MANIFEST);
  const claude = await readManifestFile(claudeFile, CLAUDE_FIELDS, false, manifestReport);
  const cogitator = await readManifestFile(
    cogitatorFile,
    { ...CLAUDE_FIELDS, ...COGITATOR_FIELDS },
    true,
    manifestReport
  );
  let fields: Record<string, unknown>;
  let added: EntryAdditions = { keepDefault: new Set() };
  if (claude || cogitator) {
    if (
      claude?.name !== undefined &&
      cogitator?.name !== undefined &&
      claude.name !== cogitator.name
    ) {
      manifestReport(
        'error',
        `${COGITATOR_MANIFEST} names the plugin "${String(cogitator.name)}" and ${CLAUDE_MANIFEST} "${String(claude.name)}", the names must agree`,
        cogitatorFile
      );
    }
    fields = { ...claude, ...cogitator };
    if (options.entry) {
      added = withEntry(fields, options.entry, manifestReport);
      fields = added.fields ?? fields;
    }
  } else {
    fields = options.entry ? entryAsManifest(options.entry, manifestReport) : {};
  }
  const name =
    typeof fields.name === 'string' && fields.name.trim() !== ''
      ? fields.name.trim()
      : (options.entry?.name ?? options.fallbackName ?? basename(root));
  const nameProblem = pluginNameProblem(name);
  if (nameProblem) manifestReport('error', `The plugin name "${name}" ${nameProblem}`);
  else if (!isKebabCase(name)) {
    report('warning', `The plugin name "${name}" is not kebab-case`);
  }
  const manifest = manifestOf({ ...fields, name }, manifestReport);
  const paths = new PathChecker(root, report);
  const skillDirs: string[] = [];
  const defaultSkills = join(root, 'skills');
  const listsOwnSkills =
    options.entry?.skills !== undefined &&
    typeof options.entry.source === 'string' &&
    /^\.\/?$/.test(options.entry.source.trim());
  if (isDirectory(defaultSkills) && !listsOwnSkills) skillDirs.push(defaultSkills);
  for (const path of listOf(manifest.skills)) {
    const resolved = paths.check(path, 'skills', { dot: true, kind: 'directory' });
    if (resolved && !skillDirs.includes(resolved)) skillDirs.push(resolved);
  }
  const rootSkill =
    skillDirs.length === 0 && manifest.skills === undefined && isFile(join(root, 'SKILL.md'));
  const commandFiles: ComponentFile[] = [];
  const inlineCommands: InlineCommand[] = [];
  if (manifest.commands === undefined || added.keepDefault.has('commands')) {
    commandFiles.push(...(await markdownUnder(join(root, 'commands'), report)));
  }
  if (manifest.commands !== undefined && isPathList(manifest.commands)) {
    if (
      !added.keepDefault.has('commands') &&
      isDirectory(join(root, 'commands')) &&
      !coversDefault(manifest.commands, 'commands')
    ) {
      report('warning', 'Default commands/ folder is ignored because the manifest sets "commands"');
    }
    for (const path of listOf(manifest.commands)) {
      const resolved = paths.check(path, 'commands', { kind: 'any' });
      if (!resolved) continue;
      if (isDirectory(resolved)) commandFiles.push(...(await markdownUnder(resolved, report)));
      else if (resolved.toLowerCase().endsWith('.md')) {
        commandFiles.push({ path: resolved, name: basename(resolved).replace(/\.md$/i, '') });
      } else report('error', `commands path is not a Markdown file or a folder: ${path}`);
    }
  } else if (manifest.commands !== undefined) {
    for (const [commandName, entry] of Object.entries(manifest.commands)) {
      if ((entry.source === undefined) === (entry.content === undefined)) {
        report('error', `commands.${commandName} must set exactly one of source and content`);
        continue;
      }
      if (entry.content !== undefined) {
        inlineCommands.push({ name: commandName, content: entry.content, entry });
        continue;
      }
      const resolved = paths.check(entry.source ?? '', `commands.${commandName}`, { kind: 'file' });
      if (!resolved) continue;
      inlineCommands.push({
        name: commandName,
        content: await readText(resolved, report),
        entry,
      });
    }
  }
  const agentFiles: ComponentFile[] = [];
  if (manifest.agents === undefined || added.keepDefault.has('agents')) {
    agentFiles.push(...(await markdownUnder(join(root, 'agents'), report)));
  }
  if (manifest.agents !== undefined) {
    if (
      !added.keepDefault.has('agents') &&
      isDirectory(join(root, 'agents')) &&
      !coversDefault(manifest.agents, 'agents')
    ) {
      report('warning', 'Default agents/ folder is ignored because the manifest sets "agents"');
    }
    for (const path of listOf(manifest.agents)) {
      const resolved = paths.check(path, 'agents', { kind: 'file' });
      if (!resolved) continue;
      if (!resolved.toLowerCase().endsWith('.md')) {
        report('error', `agents path is not a Markdown file: ${path}`);
        continue;
      }
      agentFiles.push({ path: resolved, name: basename(resolved).replace(/\.md$/i, '') });
    }
  }
  const hooks: HookSource[] = [];
  const defaultHooks = join(root, 'hooks', 'hooks.json');
  if (isFile(defaultHooks)) {
    const read = await readHooksFile(defaultHooks, report);
    if (read) hooks.push({ hooks: read, source: defaultHooks });
  }
  for (const value of listOf<string | HookSettings>(manifest.hooks)) {
    if (typeof value === 'string') {
      const resolved = paths.check(value, 'hooks', { kind: 'file' });
      if (!resolved || resolved === defaultHooks) continue;
      const read = await readHooksFile(resolved, report);
      if (read) hooks.push({ hooks: read, source: resolved });
    } else {
      hooks.push({ hooks: value, source: options.entry ? 'marketplace entry' : CLAUDE_MANIFEST });
    }
  }
  if (added.hooks) {
    const replaced = new Set(Object.keys(added.hooks));
    for (let at = hooks.length - 1; at >= 0; at--) {
      const source = hooks[at];
      if (!source) continue;
      const kept = Object.fromEntries(
        Object.entries(source.hooks).filter(([event]) => !replaced.has(event))
      ) as HookSettings;
      if (Object.keys(kept).length === 0) hooks.splice(at, 1);
      else hooks[at] = { ...source, hooks: kept };
    }
    hooks.push({ hooks: added.hooks, source: 'marketplace entry' });
  }
  const mcpServers: Record<string, PluginMcpServerConfig> = {};
  const defaultMcp = join(root, '.mcp.json');
  if (isFile(defaultMcp)) Object.assign(mcpServers, await readMcpFile(defaultMcp, report));
  for (const value of listOf<string | Readonly<Record<string, PluginMcpServerConfig>>>(
    manifest.mcpServers
  )) {
    if (typeof value === 'string') {
      if (/\.(mcpb|dxt)$/i.test(value)) {
        report(
          'warning',
          `MCP bundles (${value}) are a Claude Code feature Cogitator does not load, the server is skipped`
        );
        continue;
      }
      const resolved = paths.check(value, 'mcpServers', { kind: 'file' });
      if (!resolved) continue;
      Object.assign(mcpServers, await readMcpFile(resolved, report));
    } else {
      Object.assign(mcpServers, serversOf(value, CLAUDE_MANIFEST, report));
    }
  }
  let main: string | undefined;
  if (manifest.main !== undefined) {
    main = paths.check(manifest.main, 'main', { kind: 'file' });
  }
  const panels: { spec: PluginPanelSpec; path: string }[] = [];
  const seenPanels = new Set<string>();
  for (const spec of manifest.ui?.panels ?? []) {
    if (seenPanels.has(spec.id)) {
      report('error', `ui.panels has two panels with the id "${spec.id}"`);
      continue;
    }
    seenPanels.add(spec.id);
    const resolved = spec.entry
      ? paths.check(spec.entry, `ui.panels.${spec.id}`, { kind: 'file' })
      : undefined;
    if (resolved) panels.push({ spec, path: resolved });
  }
  noteUnapplied(root, report);
  return {
    root,
    manifest,
    format: cogitator ? 'cogitator' : 'claude',
    skillDirs,
    rootSkill,
    commandFiles: uniqueFiles(commandFiles),
    inlineCommands,
    agentFiles: uniqueFiles(agentFiles),
    hooks,
    mcpServers,
    ...(main !== undefined && { main }),
    panels,
    diagnostics,
    fatal,
  };
}

/** What `experimental_validatePlugin` found */
export interface PluginValidation {
  /** `true` unless an error was found (or, with `strict`, a warning) */
  ok: boolean;
  strict: boolean;
  /** The plugin folder */
  target: string;
  manifest?: PluginManifest;
  format?: 'claude' | 'cogitator';
  errors: PluginDiagnostic[];
  warnings: PluginDiagnostic[];
}

/**
 * Checks the plugin at `dir` as `claude plugin validate` does: the manifest, every component path,
 * and the frontmatter of the agents, commands and skills it holds. `strict` turns warnings into
 * failures
 */
export async function experimental_validatePlugin(
  dir: string,
  options: { strict?: boolean } = {}
): Promise<PluginValidation> {
  const strict = options.strict === true;
  let layout: PluginLayout;
  try {
    layout = await readPluginLayout(dir);
  } catch (error) {
    return {
      ok: false,
      strict,
      target: resolve(dir),
      errors: [
        {
          level: 'error',
          message: `The plugin folder could not be read: ${error instanceof Error ? error.message : String(error)}`,
          path: resolve(dir),
        },
      ],
      warnings: [],
    };
  }
  const extra = await checkComponents(layout);
  const all = [...layout.diagnostics, ...extra];
  if (layout.manifest.version === undefined) {
    all.push({ level: 'warning', message: 'The manifest sets no version' });
  }
  if (layout.manifest.description === undefined) {
    all.push({ level: 'warning', message: 'The manifest sets no description' });
  }
  if (layout.manifest.author === undefined) {
    all.push({ level: 'warning', message: 'The manifest sets no author' });
  }
  if (existsSync(join(layout.root, 'CLAUDE.md'))) {
    all.push({
      level: 'warning',
      message: 'CLAUDE.md at the plugin root is not loaded as project context',
      path: join(layout.root, 'CLAUDE.md'),
    });
  }
  const errors = all.filter((entry) => entry.level === 'error');
  const warnings = all.filter((entry) => entry.level === 'warning');
  return {
    ok: errors.length === 0 && (!strict || warnings.length === 0),
    strict,
    target: layout.root,
    manifest: layout.manifest,
    format: layout.format,
    errors,
    warnings,
  };
}

/** Problems in the frontmatter of the plugin's Markdown components */
async function checkComponents(layout: PluginLayout): Promise<PluginDiagnostic[]> {
  const found: PluginDiagnostic[] = [];
  for (const file of layout.agentFiles) {
    const parsed = parseSubagentFile(await readFile(file.path, 'utf8'), {
      path: file.path,
      source: 'plugin',
    });
    found.push(...parsed.diagnostics);
  }
  for (const file of layout.commandFiles) {
    const parsed = parseCommandFile(await readFile(file.path, 'utf8'), file.name, {
      path: file.path,
      source: 'plugin',
    });
    found.push(...parsed.diagnostics);
  }
  for (const dir of layout.skillDirs) {
    const folders = isFile(join(dir, 'SKILL.md'))
      ? [dir]
      : (await readdir(dir).catch(() => [] as string[]))
          .filter((name) => !name.startsWith('.'))
          .map((name) => join(dir, name))
          .filter((folder) => isFile(join(folder, 'SKILL.md')));
    for (const folder of folders) {
      const path = join(folder, 'SKILL.md');
      const parsed = parseSkillFile(await readFile(path, 'utf8'), {
        folderName: basename(folder),
        location: folder,
        path,
        source: 'host',
      });
      found.push(...parsed.diagnostics);
    }
  }
  return found;
}

/** Reads one manifest file: undefined when it is not there or cannot be read at all */
async function readManifestFile(
  file: string,
  known: Readonly<Record<string, z.ZodType>>,
  cogitator: boolean,
  report: Report
): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(file)) return undefined;
  const text = await readText(file, report);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    report(
      'error',
      `The manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      file
    );
    return {};
  }
  if (!isRecord(json)) {
    report('error', 'The manifest does not hold a JSON object', file);
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    const schema = Object.hasOwn(known, key) ? known[key] : undefined;
    if (!schema) {
      if (LISTING_FIELDS.has(key)) continue;
      if (UNAPPLIED_FIELDS.has(key)) {
        report(
          'warning',
          `${key} is a Claude Code feature Cogitator does not apply, it is ignored`,
          file
        );
        continue;
      }
      if (!cogitator && key in COGITATOR_FIELDS) {
        report('warning', `${key} belongs in ${COGITATOR_MANIFEST}, it is ignored here`, file);
        continue;
      }
      report('warning', `Unknown field '${key}', it is stripped`, file);
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      report('error', `${key}: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`, file);
      continue;
    }
    fields[key] = parsed.data;
  }
  return fields;
}

/** The manifest fields of a marketplace entry, for a plugin without a `plugin.json` */
function entryAsManifest(entry: MarketplacePluginEntry, report: Report): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (ENTRY_FIELDS.has(key) || LISTING_FIELDS.has(key)) continue;
    const schema = Object.hasOwn(CLAUDE_FIELDS, key)
      ? CLAUDE_FIELDS[key as keyof typeof CLAUDE_FIELDS]
      : undefined;
    if (!schema) continue;
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      report(
        'error',
        `marketplace entry ${key}: ${z.prettifyError(parsed.error).replace(/\n/g, ' ')}`
      );
      continue;
    }
    fields[key] = parsed.data;
  }
  if (Array.isArray(fields.hooks) || typeof fields.hooks === 'string') {
    report(
      'error',
      'hooks as a file path or array are not yet supported in a marketplace entry, they are skipped'
    );
    delete fields.hooks;
  }
  return fields;
}

/** What a marketplace entry adds to a plugin's own manifest */
interface EntryAdditions {
  /** The manifest with the entry's fields, unset when there is no manifest to add to */
  fields?: Record<string, unknown>;
  /** Component folders that still load by default although the manifest now names paths */
  keepDefault: Set<'agents' | 'commands'>;
  /** The entry's hooks, which replace the manifest's hooks of the same events */
  hooks?: HookSettings;
}

/**
 * A manifest with the component fields of its marketplace entry: with `strict` (the default)
 * appended (the default folders kept, hooks replacing the manifest's per event), without it a
 * conflict that fails the plugin
 */
function withEntry(
  fields: Record<string, unknown>,
  entry: MarketplacePluginEntry,
  report: Report
): EntryAdditions {
  const keepDefault = new Set<'agents' | 'commands'>();
  let hooks: HookSettings | undefined;
  const declared = ENTRY_COMPONENTS.filter((key) => entry[key] !== undefined);
  const merged: Record<string, unknown> = { ...fields };
  for (const key of [
    'displayName',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'defaultEnabled',
  ] as const) {
    if (entry[key] !== undefined) merged[key] = entry[key];
  }
  if (merged.version === undefined && entry.version !== undefined) merged.version = entry.version;
  if (declared.length === 0) return { fields: merged, keepDefault };
  if (entry.strict === false) {
    report(
      'error',
      `Plugin ${String(fields.name ?? entry.name)} has conflicting manifests: both plugin.json and marketplace entry specify components`
    );
    return { fields: merged, keepDefault };
  }
  for (const key of declared) {
    const value = entry[key];
    if (key === 'hooks') {
      if (!isRecord(value)) {
        report(
          'error',
          'hooks as a file path or array are not yet supported in a marketplace entry, they are skipped'
        );
        continue;
      }
      hooks = value as HookSettings;
      continue;
    }
    if (key === 'commands' && isRecord(value) && !Array.isArray(value)) {
      merged.commands =
        isRecord(fields.commands) && !Array.isArray(fields.commands)
          ? { ...fields.commands, ...value }
          : value;
      continue;
    }
    if (fields[key] === undefined && (key === 'agents' || key === 'commands')) {
      keepDefault.add(key);
    }
    merged[key] = [
      ...listOf(fields[key] as PluginManifest['skills']),
      ...listOf(value as PluginManifest['skills']),
    ];
  }
  return { fields: merged, keepDefault, ...(hooks && { hooks }) };
}

/** The fields read as a manifest, dependencies and options normalized */
function manifestOf(fields: Record<string, unknown>, report: Report): PluginManifest {
  const manifest = { ...fields } as unknown as PluginManifest & Record<string, unknown>;
  if (Array.isArray(fields.dependencies)) {
    const dependencies: PluginDependency[] = [];
    for (const entry of fields.dependencies as z.infer<typeof DependencySchema>[]) {
      const dependency: PluginDependency =
        typeof entry === 'string' ? dependencyOf(entry) : { ...entry };
      if (dependency.version !== undefined && !isValidRange(dependency.version)) {
        report(
          'warning',
          `dependencies: "${dependency.version}" of ${dependency.name} is not a semver range, the dependency is ignored`
        );
        continue;
      }
      dependencies.push(dependency);
    }
    manifest.dependencies = dependencies;
  }
  if (isRecord(fields.userConfig)) {
    const options: Record<string, PluginOptionSpec> = {};
    for (const [key, option] of Object.entries(fields.userConfig)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        report(
          'error',
          `userConfig key "${key}" may only hold letters, digits and underscores, not starting with a digit`
        );
        continue;
      }
      options[key] = option as PluginOptionSpec;
    }
    manifest.userConfig = options;
  }
  if (isRecord(fields.settings)) {
    const agent = fields.settings.agent;
    manifest.settings = typeof agent === 'string' ? { agent } : {};
  }
  if (manifest.engines?.cogitator !== undefined && !isValidRange(manifest.engines.cogitator)) {
    report('error', `engines.cogitator "${manifest.engines.cogitator}" is not a semver range`);
  }
  return manifest;
}

/** A dependency written as `name` or `name@marketplace` */
export function dependencyOf(text: string): PluginDependency {
  const at = text.lastIndexOf('@');
  return at > 0 ? { name: text.slice(0, at), marketplace: text.slice(at + 1) } : { name: text };
}

/** Checks the component paths of a manifest */
class PathChecker {
  constructor(
    private readonly root: string,
    private readonly report: Report
  ) {}

  /**
   * The absolute path of `path`, when it starts with `./` (or is `.` where `dot` allows it), holds
   * no backslash on macOS and Linux, exists as `kind` and stays inside the plugin, links followed
   */
  check(
    path: string,
    field: string,
    options: { dot?: boolean; kind: 'file' | 'directory' | 'any' }
  ): string | undefined {
    if (!(path.startsWith('./') || (options.dot === true && (path === '.' || path === './')))) {
      this.report('error', `${field} path must start with "./": ${path}`);
      return undefined;
    }
    if (process.platform !== 'win32' && path.includes('\\')) {
      this.report('error', `${field} path holds a backslash, write it with "/": ${path}`);
      return undefined;
    }
    if (path.split('/').includes('..')) {
      this.report('error', `Path contains ".." which could be a path traversal attempt: ${path}`);
      return undefined;
    }
    const absolute = resolve(this.root, path);
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      this.report('error', `${field} path not found: ${path}`);
      return undefined;
    }
    if (!isInside(this.root, real)) {
      this.report('error', `${field} path escapes plugin directory: ${path}`);
      return undefined;
    }
    const info = statSync(real);
    if (options.kind === 'file' && !info.isFile()) {
      this.report('error', `${field} path is not a file: ${path}`);
      return undefined;
    }
    if (options.kind === 'directory' && !info.isDirectory()) {
      this.report('error', `${field} path is not a folder: ${path}`);
      return undefined;
    }
    return real;
  }
}

/** Whether `path` is `root` or inside it */
export function isInside(root: string, path: string): boolean {
  const under = relative(root, path);
  return (
    under === '' || (!under.startsWith('..') && !isAbsolute(under) && !under.startsWith(`..${sep}`))
  );
}

function isPathList(value: PluginManifest['commands']): value is string | readonly string[] {
  return typeof value === 'string' || Array.isArray(value);
}

function coversDefault(value: string | readonly string[], folder: string): boolean {
  return listOf(value).some((path) => {
    const clean = path.replace(/\/+$/, '');
    return clean === `./${folder}` || clean.startsWith(`./${folder}/`);
  });
}

function listOf<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function readText(file: string, report: Report): Promise<string> {
  try {
    const info = await stat(file);
    if (info.size > MAX_JSON_BYTES) {
      report('error', `The file is larger than ${MAX_JSON_BYTES} bytes, it is skipped`, file);
      return '';
    }
    return await readFile(file, 'utf8');
  } catch (error) {
    report(
      'error',
      `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      file
    );
    return '';
  }
}

/** A hooks file: the event map under a top-level `hooks` key, as `hooks/hooks.json` holds it */
async function readHooksFile(file: string, report: Report): Promise<HookSettings | undefined> {
  const text = await readText(file, report);
  if (text === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    report(
      'error',
      `Failed to load hooks: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      file
    );
    return undefined;
  }
  if (!isRecord(json) || !isRecord(json.hooks)) {
    report(
      'error',
      'Failed to load hooks: the file must hold its events under a top-level "hooks" key',
      file
    );
    return undefined;
  }
  return json.hooks as HookSettings;
}

/** An MCP file: servers under `mcpServers`, or at its top level */
async function readMcpFile(
  file: string,
  report: Report
): Promise<Record<string, PluginMcpServerConfig>> {
  const text = await readText(file, report);
  if (text === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    report(
      'error',
      `Invalid MCP server config: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      file
    );
    return {};
  }
  if (!isRecord(json)) {
    report('error', 'Invalid MCP server config: the file does not hold a JSON object', file);
    return {};
  }
  return serversOf(isRecord(json.mcpServers) ? json.mcpServers : json, file, report);
}

function serversOf(
  value: Readonly<Record<string, unknown>>,
  source: string,
  report: Report
): Record<string, PluginMcpServerConfig> {
  const servers: Record<string, PluginMcpServerConfig> = {};
  for (const [name, config] of Object.entries(value)) {
    if (!isRecord(config)) {
      report('error', `Invalid MCP server config for "${name}": not an object`, source);
      continue;
    }
    const remote = typeof config.url === 'string';
    if (!remote && typeof config.command !== 'string') {
      report(
        'error',
        `Invalid MCP server config for "${name}": it needs a command or a url`,
        source
      );
      continue;
    }
    if (remote) {
      try {
        new URL(config.url as string);
      } catch {
        report(
          'error',
          `Invalid MCP server config for "${name}": url is not an absolute URL`,
          source
        );
        continue;
      }
    }
    servers[name] = config;
  }
  return servers;
}

/** The Markdown files under `dir`, named by their path with `:` between folders */
/** `files` without a file listed twice, the first kept */
function uniqueFiles(files: readonly ComponentFile[]): ComponentFile[] {
  const seen = new Set<string>();
  return files.filter((file) => !seen.has(file.path) && seen.add(file.path));
}

async function markdownUnder(dir: string, report: Report): Promise<ComponentFile[]> {
  if (!isDirectory(dir)) return [];
  const files: ComponentFile[] = [];
  const seen = new Set<string>();
  const walk = async (folder: string): Promise<void> => {
    let real: string;
    try {
      real = await realpath(folder);
    } catch {
      return;
    }
    if (seen.has(real) || !isInside(dir, real)) return;
    seen.add(real);
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      report(
        'error',
        `The folder could not be read: ${error instanceof Error ? error.message : String(error)}`,
        folder
      );
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_COMPONENT_FILES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push({
          path,
          name: relative(dir, path).split(sep).join(':').replace(/\.md$/i, ''),
        });
      }
    }
  };
  await walk(dir);
  return files;
}

/** Notes the parts of a Claude Code plugin Cogitator does not load, so nobody wonders */
function noteUnapplied(root: string, report: Report): void {
  const parts: [string, string][] = [
    ['.lsp.json', 'LSP servers'],
    ['output-styles', 'output styles'],
    ['themes', 'themes'],
    [join('monitors', 'monitors.json'), 'monitors'],
    ['workflows', 'workflows'],
    ['bin', 'executables on the Bash PATH'],
  ];
  for (const [path, what] of parts) {
    if (existsSync(join(root, path))) {
      report(
        'warning',
        `${path} holds ${what}, a Claude Code feature Cogitator does not apply`,
        join(root, path)
      );
    }
  }
  const settings = join(root, 'settings.json');
  if (existsSync(settings)) {
    try {
      const json: unknown = JSON.parse(readFileSync(settings, 'utf8'));
      if (isRecord(json) && Object.keys(json).length > 0) {
        report(
          'warning',
          'settings.json sets the main thread agent of Claude Code, which Cogitator does not apply',
          settings
        );
      }
    } catch {
      report('warning', 'settings.json is not valid JSON, it is ignored', settings);
    }
  }
}
