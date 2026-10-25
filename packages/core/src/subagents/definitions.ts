import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  PERMISSION_MODES,
  type CommandDefinition,
  type DefinitionDiagnostic,
  type DefinitionFileOptions,
  type DefinitionSource,
  type HookEventName,
  type HookMatcherGroup,
  type HookSettings,
  type PermissionMode,
  type PermissionSettingsOptions,
  type ReasoningEffort,
  type SubagentColor,
  type SubagentDefinition,
  type SubagentMcpServer,
  type SubagentMemoryScope,
} from '@cogitator-ai/types';
import { readFrontmatter, splitToolList } from '../skills/frontmatter';
import { readHookSettings, trustsProject } from '../hooks/settings';
import { defaultManagedDirs, defaultUserDirs } from '../permissions/settings';

/** Folders under a project root (or a managed directory) that hold definitions, first one winning */
export const DEFINITION_DIRS = ['.agents', '.cogitator', '.claude'] as const;

/** Largest definition file read */
export const MAX_DEFINITION_FILE_BYTES = 256 * 1024;

/** Longest subagent `name` Claude Code accepts */
export const MAX_SUBAGENT_NAME_LENGTH = 256;

/** Most definition files read from one folder tree */
const MAX_DEFINITION_FILES = 500;

/** Where a definition file was found */
export interface DefinitionOrigin {
  path: string;
  source: DefinitionSource;
}

/** What reading a definition file gave: the definition unless it was skipped, and its problems */
export interface ParsedDefinition<T> {
  definition?: T;
  diagnostics: DefinitionDiagnostic[];
}

type Report = (level: DefinitionDiagnostic['level'], message: string) => void;

const COLORS: readonly SubagentColor[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
];

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const MEMORY_SCOPES: readonly SubagentMemoryScope[] = ['user', 'project', 'local'];

/** Fields of Claude Code's subagent format Cogitator reads */
const SUBAGENT_FIELDS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'isolation',
  'color',
  'effort',
]);

/** Fields of Claude Code's subagent format that do not apply here: accepted, with a warning */
const UNAPPLIED_SUBAGENT_FIELDS = new Set([
  'initialPrompt',
  'autoCompactWindow',
  'omitClaudeMd',
  'experimental',
]);

/**
 * A subagent of a Markdown file in Claude Code's format, read leniently. As in Claude Code a file
 * without frontmatter or without a `name` is documentation kept next to the agents, skipped
 * without a diagnostic. Frontmatter that is not valid YAML, a `name` that starts with `-`, holds
 * `:` or is longer than 256 characters, and a missing `description` skip the file with an error.
 * A field of the wrong type or with a value the format does not allow is left out with a warning,
 * and so is a field Cogitator does not know or does not apply
 */
export function parseSubagentFile(
  text: string,
  origin: DefinitionOrigin
): ParsedDefinition<SubagentDefinition> {
  const diagnostics: DefinitionDiagnostic[] = [];
  const report: Report = (level, message) =>
    diagnostics.push({ level, message, path: origin.path });
  const read = readFrontmatter(text);
  if ('error' in read) {
    if (read.error !== 'missing') report('error', read.error);
    return { diagnostics };
  }
  for (const warning of read.warnings) report('warning', warning);
  const fields = read.fields;
  if (fields.name === undefined || fields.name === null || fields.name === '')
    return { diagnostics };
  if (typeof fields.name !== 'string') {
    report('error', 'name is not a string, the subagent is skipped');
    return { diagnostics };
  }
  const name = fields.name.trim();
  const nameProblem = subagentNameProblem(name);
  if (nameProblem) {
    report('error', `name "${name}" ${nameProblem}, the subagent is skipped`);
    return { diagnostics };
  }
  if (typeof fields.description !== 'string' || fields.description.trim() === '') {
    report('error', `Subagent "${name}" has no description, it is skipped`);
    return { diagnostics };
  }
  for (const field of Object.keys(fields)) {
    if (SUBAGENT_FIELDS.has(field)) continue;
    report(
      'warning',
      UNAPPLIED_SUBAGENT_FIELDS.has(field)
        ? `${field} is not applied by Cogitator, it is ignored`
        : `${field} is not a subagent field Cogitator recognizes, it is ignored${suggestion(field)}`
    );
  }
  const tools = toolListOf(fields.tools, 'tools', report);
  const disallowedTools = toolListOf(fields.disallowedTools, 'disallowedTools', report);
  const model = stringOf(fields.model, 'model', report);
  const permissionMode = permissionModeOf(fields.permissionMode, report);
  const maxTurns = positiveIntegerOf(fields.maxTurns, 'maxTurns', report);
  const skills = nameListOf(fields.skills, 'skills', report);
  const mcpServers = mcpServersOf(fields.mcpServers, report);
  const hooks = hooksOf(fields.hooks, origin.path, report);
  const memory = oneOf(fields.memory, MEMORY_SCOPES, 'memory', report);
  const background = booleanOf(fields.background, 'background', report);
  const isolation = oneOf(fields.isolation, ['worktree'] as const, 'isolation', report);
  const color = oneOf(fields.color, COLORS, 'color', report);
  const effort = oneOf(fields.effort, EFFORTS, 'effort', report);
  return {
    definition: {
      name,
      description: fields.description.trim(),
      prompt: read.body.trim(),
      ...(tools !== undefined && { tools }),
      ...(disallowedTools !== undefined && { disallowedTools }),
      ...(model !== undefined && { model }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(maxTurns !== undefined && { maxTurns }),
      ...(skills !== undefined && { skills }),
      ...(mcpServers !== undefined && { mcpServers }),
      ...(hooks !== undefined && { hooks }),
      ...(memory !== undefined && { memory }),
      ...(background !== undefined && { background }),
      ...(isolation !== undefined && { isolation }),
      ...(color !== undefined && { color }),
      ...(effort !== undefined && { effort }),
      source: origin.source,
      path: origin.path,
    },
    diagnostics,
  };
}

/** A hint at the field `field` was likely meant to be, when one differs only in case or `-`/`_` */
function suggestion(field: string): string {
  const plain = (name: string) => name.toLowerCase().replace(/[-_]/g, '');
  const meant = [...SUBAGENT_FIELDS].find((known) => plain(known) === plain(field));
  return meant ? ` (did you mean ${meant}?)` : '';
}

/** Why `name` cannot name a subagent, undefined when it can */
export function subagentNameProblem(name: string): string | undefined {
  if (name === '') return 'is empty';
  if (name.startsWith('-')) return 'starts with "-"';
  if (name.includes(':')) return 'holds ":", which plugin names use';
  if (name.length > MAX_SUBAGENT_NAME_LENGTH) {
    return `is longer than ${MAX_SUBAGENT_NAME_LENGTH} characters`;
  }
  if (
    [...name].some(
      (char) => char.charCodeAt(0) < 0x20 || char === '\u007f' || char === '<' || char === '>'
    )
  ) {
    return 'holds a control character, "<" or ">"';
  }
  return undefined;
}

/**
 * A command of a Markdown file in Claude Code's format: its frontmatter (optional) and the
 * template after it. `name` is what follows the `/`, from the file's path. Without a
 * `description` the first line of the template that is not empty describes it. A field of the
 * wrong type is left out with a warning, frontmatter that is not valid YAML skips the file
 */
export function parseCommandFile(
  text: string,
  name: string,
  origin: DefinitionOrigin
): ParsedDefinition<CommandDefinition> {
  const diagnostics: DefinitionDiagnostic[] = [];
  const report: Report = (level, message) =>
    diagnostics.push({ level, message, path: origin.path });
  const read = readFrontmatter(text);
  let fields: Record<string, unknown> = {};
  let template = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if ('error' in read) {
    if (read.error !== 'missing') {
      report('error', read.error);
      return { diagnostics };
    }
  } else {
    for (const warning of read.warnings) report('warning', warning);
    fields = read.fields;
    template = read.body;
  }
  template = template.trim();
  for (const field of Object.keys(fields)) {
    if (field === 'name' || field === 'paths') {
      report('warning', `${field} does not apply to a command file, it is ignored`);
    }
  }
  const description = stringOf(fields.description, 'description', report) ?? firstLineOf(template);
  const argumentHint = stringOf(fields['argument-hint'], 'argument-hint', report);
  const args = nameListOf(fields.arguments, 'arguments', report, true);
  const allowedTools = toolListOf(fields['allowed-tools'], 'allowed-tools', report);
  const model = stringOf(fields.model, 'model', report);
  return {
    definition: {
      name,
      ...(description !== undefined && { description }),
      ...(argumentHint !== undefined && { argumentHint }),
      ...(args !== undefined && { arguments: args }),
      ...(allowedTools !== undefined && { allowedTools }),
      ...(model !== undefined && { model }),
      template,
      source: origin.source,
      path: origin.path,
    },
    diagnostics,
  };
}

function firstLineOf(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  if (line === undefined) return undefined;
  return line.replace(/^#+\s*/, '').slice(0, 200);
}

function stringOf(value: unknown, field: string, report: Report): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number') return String(value);
  report('warning', `${field} is not a string, it is ignored`);
  return undefined;
}

function toolListOf(value: unknown, field: string, report: Report): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return splitToolList(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.flatMap((entry) => splitToolList(entry));
  }
  report('warning', `${field} is not a list of tools, it is ignored`);
  return undefined;
}

function nameListOf(
  value: unknown,
  field: string,
  report: Report,
  spaces = false
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const entries =
    typeof value === 'string'
      ? value.split(spaces ? /[\s,]+/ : ',')
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value
        : undefined;
  if (!entries) {
    report('warning', `${field} is not a list of names, it is ignored`);
    return undefined;
  }
  const names = entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
  return names.length > 0 ? names : undefined;
}

function permissionModeOf(value: unknown, report: Report): PermissionMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'manual') return 'default';
  if (typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)) {
    return value as PermissionMode;
  }
  report('warning', `permissionMode "${String(value)}" is not a permission mode, it is ignored`);
  return undefined;
}

function positiveIntegerOf(value: unknown, field: string, report: Report): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number === 'number' && Number.isInteger(number) && number > 0) return number;
  report('warning', `${field} is not a positive whole number, it is ignored`);
  return undefined;
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

function booleanOf(value: unknown, field: string, report: Report): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const word = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  report('warning', `${field} is not true or false, it is ignored`);
  return undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  report: Report
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  report(
    'warning',
    `${field} "${String(value)}" is not one of ${allowed.join(', ')}, it is ignored`
  );
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mcpServersOf(value: unknown, report: Report): SubagentMcpServer[] | undefined {
  if (value === undefined || value === null) return undefined;
  const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : undefined;
  if (!entries) {
    report('warning', 'mcpServers is not a list of servers, it is ignored');
    return undefined;
  }
  const servers: SubagentMcpServer[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      servers.push(entry.trim());
    } else if (isRecord(entry)) {
      for (const [name, config] of Object.entries(entry)) {
        if (isRecord(config)) servers.push({ name, config });
        else report('warning', `mcpServers.${name} is not a server definition, it is ignored`);
      }
    } else {
      report('warning', 'An entry of mcpServers is neither a server name nor a definition');
    }
  }
  return servers.length > 0 ? servers : undefined;
}

/**
 * The hooks of a subagent's frontmatter, checked as a settings file's are, with `Stop` hooks
 * turned into `SubagentStop` ones: the subagent runs as a delegated run, which stops with that
 * event, as in Claude Code
 */
function hooksOf(value: unknown, path: string, report: Report): HookSettings | undefined {
  if (value === undefined || value === null) return undefined;
  const warnings: string[] = [];
  const loaded = readHookSettings(value, 'session', path, warnings);
  for (const warning of warnings) report('warning', warning.replace(`${path}: `, ''));
  if (loaded.length === 0) return undefined;
  const settings: Partial<Record<HookEventName, HookMatcherGroup[]>> = {};
  for (const hook of loaded) {
    const event: HookEventName = hook.event === 'Stop' ? 'SubagentStop' : hook.event;
    const groups = (settings[event] ??= []);
    const group = groups.find((candidate) => candidate.matcher === hook.matcher);
    if (group) group.hooks = [...group.hooks, hook.handler];
    else
      groups.push({
        ...(hook.matcher !== undefined && { matcher: hook.matcher }),
        hooks: [hook.handler],
      });
  }
  return settings;
}

/** A folder of definitions and where its files count as coming from */
export interface DefinitionDir {
  dir: string;
  source: DefinitionSource;
}

/** The definition files found in a folder tree, with their path under it */
export interface FoundDefinitionFile {
  path: string;
  /** The path under the folder, `/` between its parts, without `.md` */
  name: string;
  source: DefinitionSource;
  text: string;
}

/**
 * The places definitions of `kind` are read for a project at `root`, highest precedence first:
 * the managed directories, the host's `dirs`, the project's folders once it is trusted, and the
 * user's folders. Whether the project is trusted is in `trusted`
 */
export function definitionDirs(
  kind: 'agents' | 'commands',
  options: DefinitionFileOptions,
  root: string
): { dirs: DefinitionDir[]; trusted: boolean } {
  const managed = (options.managedDirs ?? defaultManagedDirs()).flatMap((base) =>
    DEFINITION_DIRS.map((folder) => ({ dir: join(base, folder, kind), source: 'managed' as const }))
  );
  const extra = (options.dirs ?? []).map((dir) => ({ dir: resolve(dir), source: 'code' as const }));
  const trusted = trustsProject(
    {
      ...(options.root !== undefined && { root: options.root }),
      ...(options.trusted !== undefined && { trusted: options.trusted }),
      ...(options.trustedRoots !== undefined && { trustedRoots: options.trustedRoots }),
    },
    root
  );
  const project = trusted
    ? DEFINITION_DIRS.map((folder) => ({
        dir: join(root, folder, kind),
        source: 'project' as const,
      }))
    : [];
  const user = (options.userDirs ?? defaultDefinitionUserDirs()).map((dir) => ({
    dir: join(dir, kind),
    source: 'user' as const,
  }));
  return { dirs: [...managed, ...extra, ...project, ...user], trusted };
}

/** The user's folders of definitions: `~/.agents`, `~/.cogitator` and Claude Code's */
export function defaultDefinitionUserDirs(): string[] {
  return [join(homedir(), '.agents'), ...defaultUserDirs()];
}

/**
 * The options definition files are read with: `true` takes the places of `permissions.settings`
 * and its trust (its `trusted: true` trusts its root), as the hooks do
 */
export function definitionFileOptions(
  own: boolean | DefinitionFileOptions | undefined,
  permissions: boolean | PermissionSettingsOptions | undefined
): DefinitionFileOptions | undefined {
  if (own === undefined || own === false) return undefined;
  const shared = typeof permissions === 'object' ? permissions : undefined;
  const inherited = shared?.trusted === true ? [resolve(shared.root ?? process.cwd())] : [];
  const base: DefinitionFileOptions = {
    ...(shared?.root !== undefined && { root: shared.root }),
    ...(shared?.managedDirs !== undefined && { managedDirs: shared.managedDirs }),
  };
  if (own === true) {
    return { ...base, ...(inherited.length > 0 && { trustedRoots: inherited }) };
  }
  const roots = [...(own.trustedRoots ?? []), ...(own.trusted === undefined ? inherited : [])];
  return { ...base, ...own, ...(roots.length > 0 && { trustedRoots: roots }) };
}

/**
 * The Markdown files under each folder of `dirs`, in folder order and, within a folder, sorted by
 * path. Folders that do not exist are skipped, a folder or file that cannot be read is reported.
 * Folders named like hidden ones and `node_modules` are not entered, and a folder reached twice
 * through links is read once
 */
export async function scanDefinitionDirs(
  dirs: readonly DefinitionDir[],
  diagnostics: DefinitionDiagnostic[],
  signal?: AbortSignal
): Promise<FoundDefinitionFile[]> {
  const found: FoundDefinitionFile[] = [];
  for (const { dir, source } of dirs) {
    signal?.throwIfAborted();
    const seen = new Set<string>();
    const files: string[] = [];
    await walk(dir, seen, files, diagnostics);
    for (const path of files.sort()) {
      signal?.throwIfAborted();
      try {
        const info = await stat(path);
        if (info.size > MAX_DEFINITION_FILE_BYTES) {
          diagnostics.push({
            level: 'error',
            message: `The file is larger than ${MAX_DEFINITION_FILE_BYTES} bytes, it is skipped`,
            path,
          });
          continue;
        }
        const text = await readFile(path, 'utf8');
        const name = relative(dir, path).split(sep).join('/').replace(/\.md$/i, '');
        found.push({ path, name, source, text });
      } catch (error) {
        diagnostics.push({
          level: 'error',
          message: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
          path,
        });
      }
    }
  }
  return found;
}

async function walk(
  dir: string,
  seen: Set<string>,
  files: string[],
  diagnostics: DefinitionDiagnostic[]
): Promise<void> {
  if (files.length >= MAX_DEFINITION_FILES) return;
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push({
        level: 'error',
        message: `The folder could not be read: ${error instanceof Error ? error.message : String(error)}`,
        path: dir,
      });
    }
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(path);
        isDir = info.isDirectory();
        isFile = info.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await walk(path, seen, files, diagnostics);
    else if (isFile && entry.name.toLowerCase().endsWith('.md')) {
      if (files.length >= MAX_DEFINITION_FILES) return;
      files.push(path);
    }
  }
}
