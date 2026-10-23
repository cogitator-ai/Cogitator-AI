import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  WorkspaceError,
  type SkillCatalog,
  type SkillDiagnostic,
  type SkillDiscoveryContext,
  type SkillLoader,
  type SkillManifest,
  type SkillRegistryConfig,
  type Workspace,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { isPathAllowed } from '../tools/path-guard';
import { isCodeSkill } from '../skill';
import { parseSkillFile, SKILL_FILE, splitSkillFile } from './frontmatter';

/** Folders under a project (or home) folder that hold skill folders, the first one winning a name. */
export const SKILL_DIRS = ['.agents/skills', '.cogitator/skills', '.claude/skills'] as const;

/** Largest `SKILL.md` a registry reads */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Largest file of a skill `readFile` reads */
export const MAX_SKILL_RESOURCE_BYTES = 1024 * 1024;

/** Most files `files` lists for a skill */
export const MAX_LISTED_SKILL_FILES = 100;

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

const configSchema = z.strictObject({
  dirs: z.array(z.string().min(1)).readonly().optional(),
  workspace: z.boolean().optional(),
  project: z.string().min(1).optional(),
  user: z.union([z.boolean(), z.string().min(1)]).optional(),
});

/** A skill folder a registry found, and how to read its files. */
interface FoundSkill {
  manifest: SkillManifest;
  workspace?: Workspace;
}

interface ScanResult {
  skills: FoundSkill[];
  diagnostics: SkillDiagnostic[];
}

/**
 * Finds skills in the Agent Skills format (agentskills.io): folders with a `SKILL.md` whose YAML
 * frontmatter names the skill and says when to use it, next to the scripts, references and
 * assets the skill needs. Only the metadata is kept, the body and the other files are read when
 * the agent activates the skill.
 *
 * It searches, in this order, the first skill of a name winning: the folders of `dirs`, the
 * run's workspace (`.agents/skills`, `.cogitator/skills` and `.claude/skills` under its root,
 * unless `workspace: false`), the same folders in `project` on the host and, with `user`, in the
 * home folder. A `SKILL.md` is read leniently: one without frontmatter or `description` is
 * skipped, other departures from the format are loaded with a warning. Everything found wrong is
 * in the catalog's `diagnostics` and logged once.
 *
 * Folders on the host are scanned once and kept: call `reload()` to pick up changes. The
 * workspace is scanned on every run, since the agent may change it.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   name: 'coder',
 *   instructions: 'You write code.',
 *   skills: [new SkillRegistry({ project: process.cwd(), user: true })],
 * });
 * ```
 */
export class SkillRegistry implements SkillLoader {
  private readonly config: SkillRegistryConfig;
  private hostScan?: Promise<{ before: ScanResult; after: ScanResult }>;
  private readonly logged = new Set<string>();

  constructor(config: SkillRegistryConfig = {}) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new TypeError(`Invalid SkillRegistry config: ${z.prettifyError(parsed.error)}`);
    }
    this.config = parsed.data;
  }

  /** Forgets the skills found on the host, so the next run scans the folders again. */
  reload(): void {
    this.hostScan = undefined;
  }

  /** The skills for a run in `context.workspace` (if any), see the class description. */
  async discover(context: SkillDiscoveryContext = {}): Promise<SkillCatalog> {
    this.hostScan ??= this.scanHost();
    const host = await this.hostScan;
    const workspace = this.config.workspace !== false ? context.workspace : undefined;
    const inWorkspace = workspace
      ? await scanRoots(SKILL_DIRS.map((dir) => ({ kind: 'workspace' as const, dir, workspace })))
      : { skills: [], diagnostics: [] };
    const catalog = new FolderSkillCatalog([host.before, inWorkspace, host.after]);
    for (const diagnostic of catalog.diagnostics) this.log(diagnostic);
    return catalog;
  }

  private async scanHost(): Promise<{ before: ScanResult; after: ScanResult }> {
    const { dirs, project, user } = this.config;
    const home = user === true ? homedir() : typeof user === 'string' ? user : undefined;
    const before = await scanRoots(
      (dirs ?? []).map((dir) => ({ kind: 'host' as const, dir: resolve(dir) }))
    );
    const after = await scanRoots(
      [
        ...(project ? SKILL_DIRS.map((dir) => resolve(project, dir)) : []),
        ...(home ? SKILL_DIRS.map((dir) => resolve(home, dir)) : []),
      ].map((dir) => ({ kind: 'host' as const, dir }))
    );
    return { before, after };
  }

  private log(diagnostic: SkillDiagnostic): void {
    const key = `${diagnostic.path}\n${diagnostic.message}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    getLogger().warn(
      diagnostic.level === 'error'
        ? `Skipped a skill: ${diagnostic.message}`
        : `Skill loaded with a problem: ${diagnostic.message}`,
      { path: diagnostic.path }
    );
  }
}

type SkillRoot =
  { kind: 'host'; dir: string } | { kind: 'workspace'; dir: string; workspace: Workspace };

async function scanRoots(roots: readonly SkillRoot[]): Promise<ScanResult> {
  const result: ScanResult = { skills: [], diagnostics: [] };
  for (const root of roots) {
    const scanned =
      root.kind === 'host' ? await scanHostRoot(root.dir) : await scanWorkspaceRoot(root);
    result.skills.push(...scanned.skills);
    result.diagnostics.push(...scanned.diagnostics);
  }
  return result;
}

async function scanHostRoot(dir: string): Promise<ScanResult> {
  const result: ScanResult = { skills: [], diagnostics: [] };
  if (await isHostFile(join(dir, SKILL_FILE))) {
    await readHostSkill(dir, result);
    return result;
  }
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (error) {
    if (!isMissing(error)) {
      result.diagnostics.push({
        level: 'error',
        message: `The skills folder could not be read: ${messageOf(error)}`,
        path: dir,
      });
    }
    return result;
  }
  for (const name of names) {
    if (!name.startsWith('.')) await readHostSkill(join(dir, name), result);
  }
  return result;
}

async function isHostFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Adds the skill in `folder` on the host to `result`, when the folder has a `SKILL.md`. */
async function readHostSkill(folder: string, result: ScanResult): Promise<void> {
  const file = join(folder, SKILL_FILE);
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) return;
    if (info.size > MAX_SKILL_FILE_BYTES) {
      result.diagnostics.push({
        level: 'error',
        message: `SKILL.md is larger than ${MAX_SKILL_FILE_BYTES} bytes`,
        path: file,
      });
      return;
    }
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!isMissing(error)) {
      result.diagnostics.push({
        level: 'error',
        message: `SKILL.md could not be read: ${messageOf(error)}`,
        path: file,
      });
    }
    return;
  }
  const parsed = parseSkillFile(text, {
    folderName: basename(folder),
    location: folder,
    path: file,
    source: 'host',
  });
  result.diagnostics.push(...parsed.diagnostics);
  if (parsed.manifest) result.skills.push({ manifest: parsed.manifest });
}

async function scanWorkspaceRoot(root: { dir: string; workspace: Workspace }): Promise<ScanResult> {
  const { dir, workspace } = root;
  const result: ScanResult = { skills: [], diagnostics: [] };
  let folders: string[];
  try {
    const entries = await workspace.list(dir, { includeHidden: true });
    folders = entries
      .filter((entry) => entry.type === 'directory' || entry.type === 'symlink')
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch (error) {
    if (!isWorkspaceMissing(error)) {
      result.diagnostics.push({
        level: 'error',
        message: `The skills folder could not be read: ${messageOf(error)}`,
        path: dir,
      });
    }
    return result;
  }
  for (const name of folders) {
    const folder = posix.join(dir, name);
    const file = posix.join(folder, SKILL_FILE);
    let text: string;
    try {
      text = await workspace.read(file, { maxBytes: MAX_SKILL_FILE_BYTES });
    } catch (error) {
      if (!isWorkspaceMissing(error)) {
        result.diagnostics.push({
          level: 'error',
          message: `SKILL.md could not be read: ${messageOf(error)}`,
          path: file,
        });
      }
      continue;
    }
    const parsed = parseSkillFile(text, {
      folderName: name,
      location: folder,
      path: file,
      source: 'workspace',
    });
    result.diagnostics.push(...parsed.diagnostics);
    if (parsed.manifest) result.skills.push({ manifest: parsed.manifest, workspace });
  }
  return result;
}

/** The skills of several scans, the first skill of a name winning. */
class FolderSkillCatalog implements SkillCatalog {
  readonly skills: readonly SkillManifest[];
  readonly diagnostics: readonly SkillDiagnostic[];
  private readonly found = new Map<string, FoundSkill>();

  constructor(scans: readonly ScanResult[]) {
    const diagnostics: SkillDiagnostic[] = [];
    for (const scan of scans) {
      diagnostics.push(...scan.diagnostics);
      for (const skill of scan.skills) {
        if (!this.found.has(skill.manifest.name)) this.found.set(skill.manifest.name, skill);
      }
    }
    this.skills = [...this.found.values()].map((skill) => skill.manifest);
    this.diagnostics = diagnostics;
  }

  get(name: string): SkillManifest | undefined {
    return this.found.get(name)?.manifest;
  }

  async body(name: string): Promise<string> {
    const skill = this.require(name);
    const text = skill.workspace
      ? await skill.workspace.read(posix.join(skill.manifest.location, SKILL_FILE), {
          maxBytes: MAX_SKILL_FILE_BYTES,
        })
      : await readFile(join(skill.manifest.location, SKILL_FILE), 'utf8');
    return (splitSkillFile(text)?.body ?? text).trim();
  }

  async files(name: string): Promise<string[]> {
    const skill = this.require(name);
    const location = skill.manifest.location;
    if (skill.workspace) {
      const entries = await skill.workspace.list(location, {
        recursive: true,
        includeHidden: true,
        skipDirs: [...SKIPPED_DIRS],
        limit: MAX_LISTED_SKILL_FILES * 4,
      });
      return entries
        .filter((entry) => entry.type === 'file' || entry.type === 'symlink')
        .map((entry) => posix.relative(location, entry.path))
        .filter((path) => path !== SKILL_FILE && !path.startsWith('..'))
        .sort()
        .slice(0, MAX_LISTED_SKILL_FILES);
    }
    const files: string[] = [];
    await walkHost(location, location, files);
    return files.sort().slice(0, MAX_LISTED_SKILL_FILES);
  }

  async readFile(name: string, path: string): Promise<string> {
    const skill = this.require(name);
    const location = skill.manifest.location;
    if (skill.workspace) {
      const target = posix.normalize(posix.join(location, path.replaceAll('\\', '/')));
      if (posix.isAbsolute(path) || !target.startsWith(`${location}/`)) {
        throw new Error(`${path} is outside the folder of skill "${name}"`);
      }
      return skill.workspace.read(target, { maxBytes: MAX_SKILL_RESOURCE_BYTES });
    }
    const target = resolve(location, path);
    if (target === location || !(await isPathAllowed(target, [location]))) {
      throw new Error(`${path} is outside the folder of skill "${name}"`);
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`${path} is not a file of skill "${name}"`);
    if (info.size > MAX_SKILL_RESOURCE_BYTES) {
      throw new Error(`${path} is larger than ${MAX_SKILL_RESOURCE_BYTES} bytes`);
    }
    return readFile(target, 'utf8');
  }

  private require(name: string): FoundSkill {
    const skill = this.found.get(name);
    if (!skill) throw new Error(`There is no skill "${name}"`);
    return skill;
  }
}

async function walkHost(root: string, dir: string, files: string[]): Promise<void> {
  if (files.length > MAX_LISTED_SKILL_FILES * 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walkHost(root, full, files);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const path = relative(root, full).split(sep).join('/');
      if (path !== SKILL_FILE) files.push(path);
    }
  }
}

/**
 * The `SKILL.md` skill loaders among an agent's `skills`: the loaders it was given, and a
 * `SkillRegistry` for each configuration, made once per configuration so its scan is kept.
 */
export function skillLoadersOf(sources: readonly unknown[] | undefined): SkillLoader[] {
  if (!sources) return [];
  const loaders: SkillLoader[] = [];
  for (const source of sources) {
    if (isSkillLoader(source)) {
      loaders.push(source);
    } else if (isSkillRegistryConfig(source)) {
      let registry = registriesOfConfigs.get(source);
      if (!registry) {
        registry = new SkillRegistry(source);
        registriesOfConfigs.set(source, registry);
      }
      loaders.push(registry);
    }
  }
  return loaders;
}

const registriesOfConfigs = new WeakMap<object, SkillRegistry>();

/** Whether `value` is a skill loader: something with `discover()`. */
export function isSkillLoader(value: unknown): value is SkillLoader {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { discover?: unknown }).discover === 'function'
  );
}

function isSkillRegistryConfig(value: unknown): value is SkillRegistryConfig {
  return typeof value === 'object' && value !== null && !isCodeSkill(value);
}

/**
 * One catalog of several, for an agent with more than one source of skills: the first catalog
 * with a skill of a name wins it.
 */
export function mergeSkillCatalogs(catalogs: readonly SkillCatalog[]): SkillCatalog {
  if (catalogs.length === 1) return catalogs[0]!;
  const owners = new Map<string, SkillCatalog>();
  for (const catalog of catalogs) {
    for (const skill of catalog.skills) {
      if (!owners.has(skill.name)) owners.set(skill.name, catalog);
    }
  }
  const ownerOf = (name: string): SkillCatalog => {
    const owner = owners.get(name);
    if (!owner) throw new Error(`There is no skill "${name}"`);
    return owner;
  };
  return {
    skills: [...owners.entries()].map(([name, owner]) => owner.get(name)!),
    diagnostics: catalogs.flatMap((catalog) => catalog.diagnostics),
    get: (name) => owners.get(name)?.get(name),
    body: (name) => ownerOf(name).body(name),
    files: (name) => ownerOf(name).files(name),
    readFile: (name, path) => ownerOf(name).readFile(name, path),
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isWorkspaceMissing(error: unknown): boolean {
  return (
    error instanceof WorkspaceError &&
    (error.code === 'NOT_FOUND' || error.code === 'NOT_A_DIRECTORY' || error.code === 'NOT_A_FILE')
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
