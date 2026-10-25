import { readFile, realpath, stat as statHost } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import {
  WorkspaceError,
  workspaceGlobMatcher,
  type InstructionFileReason,
  type LoadedInstructionFile,
  type ProjectInstructionsOptions,
  type Workspace,
} from '@cogitator-ai/types';
import { splitSkillFile } from '../skills/frontmatter';

/** The instruction files looked up in each directory, in this order */
export const DEFAULT_INSTRUCTION_FILES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
];

/** Most characters project instructions take in all, imports and rules included */
export const DEFAULT_INSTRUCTIONS_MAX_CHARS = 32_000;

/** Hops of `@path` imports a file may make, imports of imports included */
export const DEFAULT_MAX_IMPORT_DEPTH = 4;

const RULES_DIR = '.claude/rules';
const BLOCK_TAG = 'project-instructions';
const MAX_OUTSIDE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_NOTICE_NAMES = 10;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;
const IMPORT_TOKEN = /(?<!\S)@((?:\\ |[^\s\0])+)/g;
const BLOCK_OPENING = new RegExp(`^<${BLOCK_TAG} path="([^"\\n]*)">$`, 'gm');

const LOAD_HEADER =
  "Project instructions from the workspace's AGENTS.md and CLAUDE.md files, from the root down to the working directory. Files further down are more specific. Follow them unless the user says otherwise.";
const REACH_HEADER = 'Project instructions for the files you are working on:';

/** What one load or reach added */
export interface InstructionsChunk {
  /** Rendered text to put into the prompt, '' when nothing new */
  text: string;
  /** Files this chunk added, in prompt order */
  files: LoadedInstructionFile[];
}

/** A file found and not read yet: workspace files keyed by their path after symlinks, outside ones by their real path */
interface LocatedFile {
  key: string;
  /** The path blocks and `LoadedInstructionFile.path` name */
  path: string;
  read(): Promise<string>;
}

type ImportTarget =
  | { kind: 'file'; file: LocatedFile }
  | { kind: 'missing' }
  | { kind: 'refused'; name: string; why: string };

interface ScopedRule {
  key: string;
  path: string;
  text: string;
  body: string;
  matches(target: string): boolean;
}

interface Admission {
  reason: InstructionFileReason;
  importedBy?: string;
  depth: number;
  /** Keys of the files whose imports led here, the importer last */
  chain: readonly string[];
}

/** What one `load()` or `reach()` collects before it is rendered */
interface Pass {
  blocks: string[];
  files: LoadedInstructionFile[];
  cut: string[];
  leftOut: string[];
  exhaustedAtStart: boolean;
  shown?: (path: string) => boolean;
  signal?: AbortSignal;
}

interface LoaderState {
  loaded: boolean;
  /** Files read, shown or left out, never brought again */
  handled: Set<string>;
  contents: Set<string>;
  dirs: Set<string>;
  scoped: Map<string, ScopedRule>;
  used: number;
  exhausted: boolean;
  noticeGiven: boolean;
  files: LoadedInstructionFile[];
  warnings: string[];
}

interface AllowedDir {
  given: string;
  real?: string;
}

/**
 * Loads the project instruction files of a workspace the way Claude Code and Codex read
 * `AGENTS.md` and `CLAUDE.md`: the files of each directory from the root down to the `cwd` with
 * their `@path` imports and the rules of `.claude/rules/` at the start, and the files of deeper
 * directories and the path-scoped rules once tools reach files they cover. Each file is brought
 * once in the loader's lifetime, and everything it brings shares one size limit.
 *
 * Calls run one at a time, and a call that aborts leaves the loader as it was before it.
 *
 * @example
 * ```ts
 * const loader = new ProjectInstructionsLoader(workspace);
 * const { text } = await loader.load();
 * const later = await loader.reach(['packages/core/src/agent.ts']);
 * ```
 */
export class ProjectInstructionsLoader {
  private readonly workspace: Workspace;
  private readonly cwd: string;
  private readonly fileNames: readonly string[];
  private readonly rules: boolean;
  private readonly nested: boolean;
  private readonly maxImportDepth: number;
  private readonly maxChars: number;
  private readonly allowImportsFrom: readonly string[];
  private allowedDirs?: Promise<AllowedDir[]>;
  private state: LoaderState = {
    loaded: false,
    handled: new Set(),
    contents: new Set(),
    dirs: new Set(),
    scoped: new Map(),
    used: 0,
    exhausted: false,
    noticeGiven: false,
    files: [],
    warnings: [],
  };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(workspace: Workspace, options: ProjectInstructionsOptions = {}) {
    this.workspace = workspace;
    this.cwd = normalizeCwd(workspace.cwd);
    this.fileNames = options.files ?? DEFAULT_INSTRUCTION_FILES;
    this.rules = options.rules ?? true;
    this.nested = options.nested ?? true;
    this.maxImportDepth = options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
    if (!(this.maxImportDepth >= 0)) throw new RangeError('maxImportDepth must be 0 or more');
    this.maxChars = options.maxChars ?? DEFAULT_INSTRUCTIONS_MAX_CHARS;
    if (!(this.maxChars >= 0)) throw new RangeError('maxChars must be 0 or more characters');
    this.allowImportsFrom = (options.allowImportsFrom ?? []).map((dir) => resolve(expandHome(dir)));
  }

  /** Every file loaded so far, in order */
  get files(): readonly LoadedInstructionFile[] {
    return this.state.files;
  }

  /** Problems met (unreadable file, import outside the workspace, cycle, depth, bad frontmatter), one line each */
  get warnings(): readonly string[] {
    return this.state.warnings;
  }

  /**
   * Reads the files of each directory from the root down to `workspace.cwd`, their imports, and
   * the unconditional rules of their `.claude/rules/`, and registers the path-scoped rules. Call
   * once, a later call brings nothing
   */
  load(signal?: AbortSignal): Promise<InstructionsChunk> {
    return this.exclusive(async () => {
      if (this.state.loaded) return { text: '', files: [] };
      const pass = this.pass(undefined, signal);
      for (const dir of directoriesDownTo(this.cwd)) {
        await this.loadDirectory(dir, 'project', pass);
      }
      this.state.loaded = true;
      return this.finish(pass, LOAD_HEADER);
    });
  }

  /**
   * What tools reaching `paths` (relative to the workspace root or absolute inside it) brings
   * that was not brought yet: the instruction files (and their imports, and the unconditional
   * rules of their `.claude/rules/`, plus registering their scoped rules) of every directory
   * below the cwd on the way to each path (when `nested`), then the scoped rules whose `paths`
   * match. `shown(path)` tells about files a conversation already holds (from an earlier run),
   * which are then marked loaded and not brought again
   */
  reach(
    paths: readonly string[],
    shown?: (path: string) => boolean,
    signal?: AbortSignal
  ): Promise<InstructionsChunk> {
    return this.exclusive(async () => {
      const pass = this.pass(shown, signal);
      const targets: string[] = [];
      for (const path of paths) {
        signal?.throwIfAborted();
        const target = await this.targetOf(path);
        if (target !== undefined && !targets.includes(target)) targets.push(target);
      }
      if (this.nested) {
        for (const target of targets) {
          for (const dir of this.nestedDirectories(target)) {
            await this.loadDirectory(dir, 'nested', pass);
          }
        }
      }
      for (const rule of [...this.state.scoped.values()]) {
        if (this.state.handled.has(rule.key)) continue;
        if (!targets.some((target) => rule.matches(target))) continue;
        await this.admitText(
          rule,
          rule.text,
          rule.body,
          { reason: 'scoped', depth: 0, chain: [] },
          pass
        );
      }
      return this.finish(pass, REACH_HEADER);
    });
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const saved = cloneState(this.state);
      try {
        return await run();
      } catch (error) {
        this.state = saved;
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private pass(
    shown: ((path: string) => boolean) | undefined,
    signal: AbortSignal | undefined
  ): Pass {
    return {
      blocks: [],
      files: [],
      cut: [],
      leftOut: [],
      exhaustedAtStart: this.state.exhausted,
      ...(shown && { shown }),
      ...(signal && { signal }),
    };
  }

  private finish(pass: Pass, header: string): InstructionsChunk {
    const parts: string[] = [];
    if (pass.blocks.length > 0) parts.push(header, ...pass.blocks);
    if (pass.cut.length > 0 || pass.leftOut.length > 0) {
      if (!pass.exhaustedAtStart || !this.state.noticeGiven) {
        parts.push(budgetNotice(this.maxChars, pass.cut, pass.leftOut));
        this.state.noticeGiven = true;
      }
    }
    return { text: parts.join('\n\n'), files: pass.files };
  }

  private async loadDirectory(
    dir: string,
    reason: InstructionFileReason,
    pass: Pass
  ): Promise<void> {
    if (this.state.dirs.has(dir)) return;
    this.state.dirs.add(dir);
    for (const name of this.fileNames) {
      const file = await this.locateWorkspaceFile(posix.join(dir, name), pass.signal, true);
      if (file) await this.admit(file, { reason, depth: 0, chain: [] }, pass);
    }
    if (!this.rules) return;
    for (const path of await this.ruleFiles(dir, pass.signal)) {
      await this.admitRule(path, dir, pass);
    }
  }

  private async admitRule(path: string, base: string, pass: Pass): Promise<void> {
    const file = await this.locateWorkspaceFile(path, pass.signal, false);
    if (!file || this.state.handled.has(file.key) || this.state.scoped.has(file.key)) return;
    const text = await this.readText(file, pass.signal);
    if (text === undefined) return;
    const parts = splitSkillFile(text);
    const body = parts ? parts.body : text;
    const patterns = parts ? this.rulePatterns(parts.frontmatter, file.path) : undefined;
    if (!patterns) {
      await this.admitText(file, text, body, { reason: 'rule', depth: 0, chain: [] }, pass);
      return;
    }
    const matchers = patterns.map((pattern) => workspaceGlobMatcher(pattern));
    this.state.scoped.set(file.key, {
      key: file.key,
      path: file.path,
      text,
      body,
      matches: (target) => {
        const inBase = relativeWithin(base, target);
        return inBase !== undefined && matchers.some((matches) => matches(inBase));
      },
    });
  }

  private async admit(file: LocatedFile, admission: Admission, pass: Pass): Promise<void> {
    if (this.state.handled.has(file.key)) {
      if (admission.chain.includes(file.key)) {
        this.warn(
          `${admission.importedBy} imports ${file.path}, which is already on its import chain, so the cycle stops there`
        );
      }
      return;
    }
    if (admission.depth > this.maxImportDepth) {
      this.warn(
        `${admission.importedBy} imports ${file.path} past the import depth limit of ${this.maxImportDepth}, so it is skipped`
      );
      return;
    }
    const text = await this.readText(file, pass.signal);
    if (text === undefined) return;
    await this.admitText(file, text, text, admission, pass);
  }

  /** Takes in a file read: renders `body` unless its content was brought already, then follows its imports */
  private async admitText(
    file: Pick<LocatedFile, 'key' | 'path'>,
    text: string,
    body: string,
    admission: Admission,
    pass: Pass
  ): Promise<void> {
    this.state.handled.add(file.key);
    if (this.state.contents.has(text)) return;
    this.state.contents.add(text);
    const content = cleanContent(body);
    if (!pass.shown?.(file.path)) this.render(file.path, content, admission, pass);

    const chain = [...admission.chain, file.key];
    for (const spec of importsIn(content)) {
      let target = await this.locateImport(spec, file.path, pass.signal);
      const trimmed = spec.replace(TRAILING_PUNCTUATION, '');
      if (target.kind === 'missing' && trimmed.length > 0 && trimmed !== spec) {
        target = await this.locateImport(trimmed, file.path, pass.signal);
      }
      if (target.kind === 'missing') {
        this.warn(`${file.path} imports @${spec}, which does not exist, so it is skipped`);
        continue;
      }
      if (target.kind === 'refused') {
        this.warn(`${file.path} imports ${target.name}, which ${target.why}, so it is skipped`);
        continue;
      }
      await this.admit(
        target.file,
        { reason: 'import', importedBy: file.path, depth: admission.depth + 1, chain },
        pass
      );
    }
  }

  private render(path: string, content: string, admission: Admission, pass: Pass): void {
    if (content.length === 0) return;
    const remaining = this.maxChars - this.state.used;
    let kept = content;
    if (!this.state.exhausted && content.length > remaining) {
      kept = cutAt(content, remaining);
      this.state.exhausted = true;
    }
    if (this.state.exhausted && kept === content) {
      pass.leftOut.push(path);
      return;
    }
    if (kept.length === 0) {
      pass.leftOut.push(path);
      return;
    }
    const truncated = kept !== content;
    if (truncated) pass.cut.push(path);
    this.state.used += kept.length;
    const entry: LoadedInstructionFile = {
      path,
      reason: admission.reason,
      ...(admission.importedBy !== undefined && { importedBy: admission.importedBy }),
      chars: kept.length,
      ...(truncated && { truncated: true }),
    };
    pass.blocks.push(renderBlock(path, kept));
    pass.files.push(entry);
    this.state.files.push(entry);
  }

  private async locateWorkspaceFile(
    path: string,
    signal: AbortSignal | undefined,
    quietWhenMissing: boolean
  ): Promise<LocatedFile | undefined> {
    signal?.throwIfAborted();
    try {
      const info = await this.workspace.stat(path);
      if (info.type === 'file') return this.workspaceFile(info.path, path);
      if (!quietWhenMissing) this.warn(`${path} is not a file, so it is skipped`);
      return undefined;
    } catch (error) {
      if (isMissing(error)) {
        if (!quietWhenMissing) this.warn(`${path} does not exist anymore, so it is skipped`);
      } else if (WorkspaceError.is(error, 'OUTSIDE_ROOT')) {
        this.warn(`${path} leads outside the workspace, so it is skipped`);
      } else {
        this.warn(`${path} could not be read (${messageOf(error)}), so it is skipped`);
      }
      return undefined;
    }
  }

  private workspaceFile(real: string, path: string): LocatedFile {
    return { key: `workspace:${real}`, path, read: () => this.workspace.read(real) };
  }

  private async readText(
    file: LocatedFile,
    signal: AbortSignal | undefined
  ): Promise<string | undefined> {
    signal?.throwIfAborted();
    try {
      return normalizeText(await file.read());
    } catch (error) {
      this.warn(`${file.path} could not be read (${messageOf(error)}), so it is skipped`);
      return undefined;
    }
  }

  /** The `.md` files under `dir/.claude/rules/`, in subdirectories and symlinked ones too, sorted by path */
  private async ruleFiles(dir: string, signal: AbortSignal | undefined): Promise<string[]> {
    const found: string[] = [];
    const entered = new Set<string>();
    const walk = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      let entries;
      try {
        entries = await this.workspace.list(path);
      } catch (error) {
        if (isMissing(error) || WorkspaceError.is(error, 'NOT_A_DIRECTORY')) return;
        if (WorkspaceError.is(error, 'OUTSIDE_ROOT')) {
          this.warn(`${path} leads outside the workspace, so its rules are skipped`);
        } else {
          this.warn(`${path} could not be listed (${messageOf(error)}), so its rules are skipped`);
        }
        return;
      }
      for (const entry of entries) {
        let type = entry.type;
        let real = entry.path;
        if (type === 'symlink') {
          signal?.throwIfAborted();
          try {
            const info = await this.workspace.stat(entry.path);
            type = info.type;
            real = info.path;
          } catch (error) {
            if (WorkspaceError.is(error, 'OUTSIDE_ROOT')) {
              this.warn(`${entry.path} leads outside the workspace, so it is skipped`);
            }
            continue;
          }
        }
        if (type === 'directory' && !entered.has(real)) {
          entered.add(real);
          await walk(entry.path);
        } else if (type === 'file' && entry.name.endsWith('.md')) {
          found.push(entry.path);
        }
      }
    };
    await walk(posix.join(dir, RULES_DIR));
    return [...new Set(found)].sort();
  }

  /** The globs of a rule's `paths`, or undefined when the rule applies to every file */
  private rulePatterns(frontmatter: string, path: string): string[] | undefined {
    const everyFile = 'so it applies to every file';
    let data: unknown;
    try {
      const document = parseDocument(frontmatter, { prettyErrors: false });
      const [problem] = document.errors;
      if (problem) {
        this.warn(
          `${path} has frontmatter that is not valid YAML (${problem.message}), ${everyFile}`
        );
        return undefined;
      }
      data = document.toJS({ maxAliasCount: 100 });
    } catch (error) {
      this.warn(
        `${path} has frontmatter that is not valid YAML (${messageOf(error)}), ${everyFile}`
      );
      return undefined;
    }
    if (data === null || data === undefined) return undefined;
    if (typeof data !== 'object' || Array.isArray(data)) {
      this.warn(`${path} has frontmatter that is not a mapping of fields, ${everyFile}`);
      return undefined;
    }
    const value = 'paths' in data ? data.paths : undefined;
    if (value === undefined || value === null) return undefined;
    let patterns: string[];
    if (typeof value === 'string') {
      patterns = splitPatternList(value);
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      patterns = value;
    } else {
      this.warn(
        `${path} has paths that are neither a list nor a comma-separated string, ${everyFile}`
      );
      return undefined;
    }
    const cleaned = patterns
      .map((pattern) =>
        pattern
          .trim()
          .replace(/^(?:\.\/)+/, '')
          .replace(/^\/+/, '')
      )
      .filter((pattern) => pattern.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  }

  private async locateImport(
    spec: string,
    importer: string,
    signal: AbortSignal | undefined
  ): Promise<ImportTarget> {
    signal?.throwIfAborted();
    if (spec === '~' || spec.startsWith('~/')) return this.locateAbsolute(expandHome(spec));
    if (isAbsolute(spec)) return this.locateAbsolute(resolve(spec));
    if (isAbsolute(importer)) return this.locateAbsolute(resolve(dirname(importer), spec));
    const path = posix.normalize(posix.join(posix.dirname(importer), spec));
    if (path === '..' || path.startsWith('../')) {
      return this.locateOutside(resolve(this.workspace.root, path));
    }
    return this.locateInWorkspace(path, path);
  }

  private locateAbsolute(path: string): Promise<ImportTarget> {
    return this.locateInWorkspace(path, undefined);
  }

  private async locateInWorkspace(path: string, name: string | undefined): Promise<ImportTarget> {
    try {
      const info = await this.workspace.stat(path);
      const shownAs = name ?? info.path;
      if (info.type !== 'file') return { kind: 'refused', name: shownAs, why: 'is not a file' };
      return { kind: 'file', file: this.workspaceFile(info.path, shownAs) };
    } catch (error) {
      if (isMissing(error)) return { kind: 'missing' };
      if (WorkspaceError.is(error, 'OUTSIDE_ROOT')) {
        return this.locateOutside(isAbsolute(path) ? path : resolve(this.workspace.root, path));
      }
      return {
        kind: 'refused',
        name: name ?? path,
        why: `could not be read (${messageOf(error)})`,
      };
    }
  }

  private async locateOutside(path: string): Promise<ImportTarget> {
    let real: string;
    try {
      real = await realpath(path);
    } catch (error) {
      if (isMissingOnHost(error)) return { kind: 'missing' };
      return { kind: 'refused', name: path, why: `could not be read (${messageOf(error)})` };
    }
    const allowed = await this.allowedRoots();
    if (!allowed.some((dir) => isWithinHost(dir, real))) {
      return {
        kind: 'refused',
        name: path,
        why: 'is outside the workspace and not under allowImportsFrom',
      };
    }
    try {
      const info = await statHost(real);
      if (!info.isFile()) return { kind: 'refused', name: path, why: 'is not a file' };
      if (info.size > MAX_OUTSIDE_FILE_BYTES) {
        return {
          kind: 'refused',
          name: path,
          why: `is larger than ${MAX_OUTSIDE_FILE_BYTES} bytes`,
        };
      }
    } catch (error) {
      return { kind: 'refused', name: path, why: `could not be read (${messageOf(error)})` };
    }
    return {
      kind: 'file',
      file: { key: `host:${real}`, path, read: () => readFile(real, 'utf8') },
    };
  }

  private async allowedRoots(): Promise<string[]> {
    this.allowedDirs ??= Promise.all(
      this.allowImportsFrom.map(async (given): Promise<AllowedDir> => {
        try {
          return { given, real: await realpath(given) };
        } catch {
          return { given };
        }
      })
    );
    const dirs = await this.allowedDirs;
    const roots: string[] = [];
    for (const dir of dirs) {
      if (dir.real === undefined) {
        this.warn(`allowImportsFrom names ${dir.given}, which does not exist`);
      } else {
        roots.push(dir.real);
      }
    }
    return roots;
  }

  /** `path` as a path relative to the workspace root, or undefined when it is not inside it */
  private async targetOf(path: string): Promise<string | undefined> {
    if (path.length === 0 || path.includes('\0')) return undefined;
    if (isAbsolute(path)) {
      const inRoot = relative(this.workspace.root, resolve(path));
      if (inRoot === '') return '.';
      if (!escapes(inRoot, sep) && !isAbsolute(inRoot)) return inRoot.split(sep).join('/');
      try {
        const parent = await this.workspace.stat(dirname(path));
        if (parent.type !== 'directory') return undefined;
        return parent.path === '.' ? basename(path) : `${parent.path}/${basename(path)}`;
      } catch {
        return undefined;
      }
    }
    const normalized = posix.normalize(path).replace(/\/+$/, '');
    if (normalized === '' || normalized === '.') return '.';
    if (escapes(normalized, '/') || normalized.startsWith('/')) return undefined;
    return normalized;
  }

  /** The directories strictly below the cwd on the way to `target`, top first */
  private nestedDirectories(target: string): string[] {
    const dir = posix.dirname(target);
    const below = relativeWithin(this.cwd, dir);
    if (below === undefined || below === '.') return [];
    const dirs: string[] = [];
    let current = this.cwd;
    for (const segment of below.split('/')) {
      current = current === '.' ? segment : `${current}/${segment}`;
      dirs.push(current);
    }
    return dirs;
  }

  private warn(message: string): void {
    if (!this.state.warnings.includes(message)) this.state.warnings.push(message);
  }
}

/** The paths the rendered blocks of `text` name, in order, for `shown` checks: empty when `text` holds no block */
export function instructionPathsIn(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(BLOCK_OPENING)) {
    const attribute = match[1];
    if (attribute !== undefined) paths.push(unescapeAttribute(attribute));
  }
  return paths;
}

function cloneState(state: LoaderState): LoaderState {
  return {
    ...state,
    handled: new Set(state.handled),
    contents: new Set(state.contents),
    dirs: new Set(state.dirs),
    scoped: new Map(state.scoped),
    files: [...state.files],
    warnings: [...state.warnings],
  };
}

function normalizeCwd(cwd: string): string {
  const normalized = posix.normalize(cwd || '.').replace(/\/+$/, '');
  return normalized === '' || normalized === '.' ? '.' : normalized;
}

/** `.` and then every directory down to `cwd` */
function directoriesDownTo(cwd: string): string[] {
  const dirs = ['.'];
  if (cwd === '.') return dirs;
  let current = '';
  for (const segment of cwd.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}

/** `path` relative to the workspace directory `base`, or undefined when it lies outside it */
function relativeWithin(base: string, path: string): string | undefined {
  if (base === '.') return path;
  if (path === base) return '.';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
}

function escapes(path: string, separator: string): boolean {
  return path === '..' || path.startsWith(`..${separator}`);
}

function isWithinHost(dir: string, path: string): boolean {
  const inside = relative(dir, path);
  return inside === '' || (!escapes(inside, sep) && !isAbsolute(inside));
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function isMissing(error: unknown): boolean {
  return WorkspaceError.is(error, 'NOT_FOUND') || WorkspaceError.is(error, 'NOT_A_DIRECTORY');
}

function isMissingOnHost(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeText(text: string): string {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return source.replace(/\r\n?/g, '\n');
}

/** The text a file contributes: block-level HTML comments out, blank lines around it trimmed */
function cleanContent(body: string): string {
  return stripHtmlComments(body)
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
}

/** A function of the lines of a Markdown text, in order, telling which belong to a fenced code block, fences included */
function fenceTracker(): (line: string) => boolean {
  let fence: { char: string; length: number } | undefined;
  return (line) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close !== undefined && close.startsWith(fence.char) && close.length >= fence.length) {
        fence = undefined;
      }
      return true;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = open?.[1];
    if (marker === undefined) return false;
    if (marker.startsWith('`') && (open?.[2] ?? '').includes('`')) return false;
    fence = { char: marker.charAt(0), length: marker.length };
    return true;
  };
}

/** `text` without the HTML comments that start a line outside fenced code, an unclosed one kept */
function stripHtmlComments(text: string): string {
  const lines = text.split('\n');
  const inCode = fenceTracker();
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index] ?? '';
    if (inCode(line)) {
      kept.push(line);
      continue;
    }
    let stripped = false;
    while (/^ {0,3}<!--/.test(line)) {
      let end = line.indexOf('-->', line.indexOf('<!--') + 4);
      let closing = index;
      let closingLine = line;
      while (end === -1 && closing + 1 < lines.length) {
        closing++;
        closingLine = lines[closing] ?? '';
        end = closingLine.indexOf('-->');
      }
      if (end === -1) break;
      line = closingLine.slice(end + 3);
      index = closing;
      stripped = true;
    }
    if (stripped && line.trim() === '') continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** The paths of the `@path` imports of `content`, as written with `\ ` unescaped, in order */
function importsIn(content: string): string[] {
  const specs: string[] = [];
  for (const match of maskCode(content).matchAll(IMPORT_TOKEN)) {
    const token = match[1];
    if (token === undefined || token.startsWith('"') || token.startsWith("'")) continue;
    specs.push(token.replace(/\\ /g, ' '));
  }
  return specs;
}

/** `text` with fenced code blocks emptied and code spans masked with NUL characters, line breaks kept */
function maskCode(text: string): string {
  const inCode = fenceTracker();
  const visible = text
    .split('\n')
    .map((line) => (inCode(line) ? '' : line))
    .join('\n');
  const blankLine = /[ \t]*(?:\n|$)/y;
  let masked = '';
  let index = 0;
  while (index < visible.length) {
    const char = visible[index];
    if (char === '\\' && visible[index + 1] === '`') {
      masked += '\\`';
      index += 2;
      continue;
    }
    if (char !== '`') {
      masked += char;
      index++;
      continue;
    }
    let runEnd = index;
    while (visible[runEnd] === '`') runEnd++;
    const run = runEnd - index;
    let closing = -1;
    let scan = runEnd;
    while (scan < visible.length) {
      if (visible[scan] === '\n') {
        blankLine.lastIndex = scan + 1;
        if (blankLine.test(visible)) break;
      }
      if (visible[scan] === '`') {
        let closeEnd = scan;
        while (visible[closeEnd] === '`') closeEnd++;
        if (closeEnd - scan === run) {
          closing = scan;
          break;
        }
        scan = closeEnd;
        continue;
      }
      scan++;
    }
    if (closing === -1) {
      masked += visible.slice(index, runEnd);
      index = runEnd;
      continue;
    }
    masked += visible.slice(index, closing + run).replace(/[^\n]/g, '\0');
    index = closing + run;
  }
  return masked;
}

/** A comma-separated list of globs, commas inside `{}` and `[]` kept */
function splitPatternList(list: string): string[] {
  const patterns: string[] = [];
  let current = '';
  let braces = 0;
  let inClass = false;
  for (const char of list) {
    if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '{') {
      braces++;
    } else if (char === '}') {
      braces = Math.max(0, braces - 1);
    } else if (char === ',' && braces === 0) {
      patterns.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  patterns.push(current);
  return patterns;
}

/** The first `limit` characters of `text`, one less when the limit splits a surrogate pair */
function cutAt(text: string, limit: number): string {
  if (limit <= 0) return '';
  let end = Math.min(limit, text.length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

function renderBlock(path: string, content: string): string {
  return `<${BLOCK_TAG} path="${escapeAttribute(path)}">\n${content}\n</${BLOCK_TAG}>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/\n/g, '&#10;');
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&#10;/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function budgetNotice(
  maxChars: number,
  cut: readonly string[],
  leftOut: readonly string[]
): string {
  const clauses: string[] = [];
  if (cut.length > 0) clauses.push(`${listNames(cut)} ${cut.length === 1 ? 'was' : 'were'} cut`);
  if (leftOut.length > 0) {
    clauses.push(`${listNames(leftOut)} ${leftOut.length === 1 ? 'was' : 'were'} left out`);
  }
  return `Project instructions are limited to ${maxChars} characters, so ${clauses.join(' and ')}.`;
}

function listNames(names: readonly string[]): string {
  if (names.length <= MAX_NOTICE_NAMES) return names.join(', ');
  return `${names.slice(0, MAX_NOTICE_NAMES).join(', ')} and ${names.length - MAX_NOTICE_NAMES} more`;
}
