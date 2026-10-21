/**
 * Memory files: notes under `/memories` an agent views and edits with the memory tool, the
 * commands and their answers those of Anthropic's memory tool, every change kept as a version
 */

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  MEMORY_FILE_CONFLICT,
  type MemoryFileAdapter,
  type MemoryFileAuthor,
  type MemoryFileFilter,
  type MemoryFileVersion,
  type MemoryItemScope,
  type MemoryResult,
} from '@cogitator-ai/types';
import { narrowness } from './memory-items';

/** The directory every memory file lives under */
export const MEMORY_ROOT = '/memories';

/** Lines a file holds at most, as the memory tool allows */
const MAX_LINES = 999_999;
const LINE_NUMBER_WIDTH = String(MAX_LINES).length;
/** Times a write is tried again when another writer took the version's place first */
const WRITE_ATTEMPTS = 3;
/** What a redacted version holds instead of its content */
export const REDACTED_CONTENT = '[redacted]';

/** A command of the memory tool, as Anthropic's `memory_20250818` tool sends it */
export type MemoryFileCommand =
  | { command: 'view'; path: string; view_range?: number[] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

/**
 * The branch of a thread a run stands on, so it sees the versions written on that branch and on
 * none of the others, while versions of other threads are seen as they are
 */
export interface MemoryFilePlace {
  threadId: string;
  /** Ids of the entries on the run's branch, oldest first */
  pathIds: ReadonlySet<string>;
  /** The entry a write is placed after: the newest of the branch */
  entryId?: string;
}

/** Who reads and writes memory files, and where */
export interface MemoryFileAccess {
  /** Where new versions go */
  scope: MemoryItemScope;
  /** What the run sees, `scope` by default */
  visibleTo?: MemoryItemScope;
  place?: MemoryFilePlace;
  /** Views only: every change fails */
  readOnly?: boolean;
  author?: MemoryFileAuthor;
  /**
   * Hears of the version of a file a command showed or wrote: its path and SHA-256, null once
   * the command deleted it. The memory tool keeps it to refuse an edit of a file changed since.
   */
  observe?: (path: string, sha256: string | null) => void;
}

/** A file as it stands for an access */
export interface MemoryFile {
  path: string;
  content: string;
  sha256: string;
  /** Bytes of its content */
  size: number;
  version: MemoryFileVersion;
}

/** A command the memory tool refuses, with the message the model reads */
export class MemoryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryFileError';
  }
}

/** `path` written as memory keeps it, or a {@link MemoryFileError} when it is not one */
export function memoryPath(path: string): string {
  if (!path.startsWith(MEMORY_ROOT)) {
    throw new MemoryFileError(`Path must start with /memories, got: ${path}`);
  }
  const rest = path.slice(MEMORY_ROOT.length);
  if (rest !== '' && !rest.startsWith('/')) {
    throw new MemoryFileError(`Path must start with /memories, got: ${path}`);
  }
  const parts = rest.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '..' || part === '.' || part.includes('\\'))) {
    throw new MemoryFileError(`Path ${path} would escape /memories directory`);
  }
  return parts.length === 0 ? MEMORY_ROOT : `${MEMORY_ROOT}/${parts.join('/')}`;
}

/** SHA-256 of `content`, as hex */
export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Whether `candidate` keeps memory file versions */
export function isMemoryFileAdapter(candidate: unknown): candidate is MemoryFileAdapter {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as Partial<MemoryFileAdapter>).putFileVersions === 'function' &&
    typeof (candidate as Partial<MemoryFileAdapter>).findFileVersions === 'function' &&
    typeof (candidate as Partial<MemoryFileAdapter>).redactFileVersions === 'function' &&
    typeof (candidate as Partial<MemoryFileAdapter>).deleteFileVersions === 'function'
  );
}

const SCOPE_FIELDS = ['userId', 'projectId', 'threadId'] as const;

/** Whether `version` meets `filter`, for a storage that filters in process */
export function matchesFileFilter(version: MemoryFileVersion, filter: MemoryFileFilter): boolean {
  const { visibleTo, scope } = filter;
  return (
    version.scope.agentId === filter.agentId &&
    (filter.ids === undefined || filter.ids.includes(version.id)) &&
    (filter.paths === undefined || filter.paths.includes(version.path)) &&
    (filter.prefix === undefined || version.path.startsWith(filter.prefix)) &&
    (visibleTo === undefined ||
      SCOPE_FIELDS.every(
        (field) => version.scope[field] === undefined || version.scope[field] === visibleTo[field]
      )) &&
    (scope === undefined || SCOPE_FIELDS.every((field) => version.scope[field] === scope[field]))
  );
}

/** Oldest first: by `createdAt`, then `sequence`, then `id`, the order versions are found in */
export function byFileVersion(a: MemoryFileVersion, b: MemoryFileVersion): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.sequence - b.sequence ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The key a scope and a path keep their versions under */
export function fileKeyOf(scope: MemoryItemScope, path: string): string {
  return JSON.stringify([
    scope.agentId,
    scope.userId ?? null,
    scope.projectId ?? null,
    scope.threadId ?? null,
    path,
  ]);
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function sizeOf(bytes: number): string {
  if (bytes === 0) return '0B';
  const units = ['B', 'K', 'M', 'G'];
  const at = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / 1024 ** at;
  return `${size % 1 === 0 ? size.toString() : size.toFixed(1)}${units[at]}`;
}

function numbered(lines: readonly string[], from: number): string {
  return lines
    .map((line, at) => `${String(at + from).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`)
    .join('\n');
}

/** Whether `path` is `directory` or lies under it */
function under(path: string, directory: string): boolean {
  return directory === MEMORY_ROOT
    ? path.startsWith(`${MEMORY_ROOT}/`)
    : path === directory || path.startsWith(`${directory}/`);
}

/** A version a change adds, before its scope and place are known */
interface PlannedWrite {
  path: string;
  content: string | null;
  renamedFrom?: string;
  /** The path whose version in front decides the scope, the write's own by default */
  scopeOf?: string;
}

/** `path` as the path of a file: a path that ends in `/` names a directory */
function filePath(path: string): string {
  const target = memoryPath(path);
  if (target === MEMORY_ROOT || path.endsWith('/')) {
    throw new MemoryFileError(`The path ${path} is not a file.`);
  }
  return target;
}

/** Refuses text a file cannot hold in every store */
function writableText(text: string): void {
  if (text.includes('\u0000')) {
    throw new MemoryFileError('Memory files cannot hold NUL characters');
  }
}

/** Refuses a file whose directory, or one above it, is a file */
function fileUnder(current: ReadonlyMap<string, MemoryFile>, target: string, path: string): void {
  for (
    let at = target.lastIndexOf('/');
    at > MEMORY_ROOT.length;
    at = target.lastIndexOf('/', at - 1)
  ) {
    const directory = target.slice(0, at);
    if (current.has(directory)) {
      throw new MemoryFileError(`Cannot create ${path}: ${directory} is a file`);
    }
  }
}

const writing = new WeakMap<MemoryFileAdapter, Map<string, Promise<void>>>();

export interface MemoryFilesOptions {
  adapter: MemoryFileAdapter;
  now?: () => Date;
}

/**
 * Memory files of an adapter, read and changed as the memory tool does it. A run sees the files
 * of the scopes it is let into, the version of the narrowest scope when two hold one path, and
 * in its own thread only the versions of its branch. A change adds a version in the access's
 * scope, or in the narrower scope of the version it changes, after the newest one of its path, and two writers never add the same place: the store
 * refuses the second, and the change is made again on what stands then. A change of many files,
 * such as a renamed directory, is added whole or not at all.
 */
export class MemoryFiles {
  private readonly adapter: MemoryFileAdapter;
  private readonly now: () => Date;

  constructor(config: MemoryFilesOptions) {
    this.adapter = config.adapter;
    this.now = config.now ?? (() => new Date());
  }

  /** Runs a command of the memory tool, the answer as the model reads it */
  async run(access: MemoryFileAccess, command: MemoryFileCommand): Promise<string> {
    switch (command.command) {
      case 'view':
        return this.view(access, command.path, command.view_range);
      case 'create':
        return this.create(access, command.path, command.file_text);
      case 'str_replace':
        return this.strReplace(access, command.path, command.old_str, command.new_str);
      case 'insert':
        return this.insert(access, command.path, command.insert_line, command.insert_text);
      case 'delete':
        return this.delete(access, command.path);
      case 'rename':
        return this.rename(access, command.old_path, command.new_path);
    }
  }

  /** The files the access sees, by path */
  async list(access: MemoryFileAccess, directory = MEMORY_ROOT): Promise<MemoryFile[]> {
    const root = memoryPath(directory);
    const versions = unwrap(
      await this.adapter.findFileVersions({
        agentId: access.scope.agentId,
        visibleTo: access.visibleTo ?? access.scope,
        ...(root !== MEMORY_ROOT && { prefix: root }),
      })
    );
    return this.filesOf(access, versions, root);
  }

  /** The files `versions` make for the access under `root`: the version in front of each path */
  private filesOf(
    access: MemoryFileAccess,
    versions: readonly MemoryFileVersion[],
    root = MEMORY_ROOT
  ): MemoryFile[] {
    const heads = new Map<string, MemoryFileVersion>();
    for (const version of versions) {
      if (!this.sees(access, version) || !under(version.path, root)) continue;
      const known = heads.get(version.path);
      if (!known || this.wins(version, known)) heads.set(version.path, version);
    }
    return [...heads.values()]
      .filter((version) => version.content !== null)
      .map((version) => this.fileOf(version))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** The file at `path` as the access sees it, undefined when there is none */
  async read(access: MemoryFileAccess, path: string): Promise<MemoryFile | undefined> {
    const file = memoryPath(path);
    return (await this.list(access, file)).find((found) => found.path === file);
  }

  /** Every version of the file at `path` the access sees, oldest first */
  async history(access: MemoryFileAccess, path: string): Promise<MemoryFileVersion[]> {
    const file = memoryPath(path);
    const versions = unwrap(
      await this.adapter.findFileVersions({
        agentId: access.scope.agentId,
        visibleTo: access.visibleTo ?? access.scope,
        paths: [file],
      })
    );
    return versions.filter((version) => this.sees(access, version));
  }

  async view(access: MemoryFileAccess, path: string, range?: readonly number[]): Promise<string> {
    const target = memoryPath(path);
    const files = await this.list(access, target);
    const file = files.find((found) => found.path === target);
    if (file) {
      const lines = file.content.split('\n');
      if (lines.length > MAX_LINES) {
        throw new MemoryFileError(
          `File ${path} has too many lines (${lines.length}). Maximum is ${MAX_LINES.toLocaleString('en-US')} lines.`
        );
      }
      let shown = lines;
      let from = 1;
      if (range?.length === 2) {
        const start = Math.max(1, range[0] ?? 1) - 1;
        const end = range[1] === -1 ? lines.length : (range[1] ?? lines.length);
        shown = lines.slice(start, end);
        from = start + 1;
      }
      access.observe?.(file.path, file.sha256);
      return `Here's the content of ${path} with line numbers:\n${numbered(shown, from)}`;
    }
    if (target !== MEMORY_ROOT && files.length === 0) {
      throw new MemoryFileError(`The path ${path} does not exist. Please provide a valid path.`);
    }
    const shown = path.replace(/\/+$/, '') || MEMORY_ROOT;
    const entries = new Map<string, number>();
    for (const found of files) {
      const parts = found.path.slice(target.length + 1).split('/');
      for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
        const relative = parts.slice(0, depth).join('/');
        const key = depth < parts.length ? `${relative}/` : relative;
        entries.set(key, (entries.get(key) ?? 0) + found.size);
      }
    }
    const total = files.reduce((sum, found) => sum + found.size, 0);
    const lines = [
      `${sizeOf(total)}\t${shown}`,
      ...[...entries.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([relative, size]) => `${sizeOf(size)}\t${shown}/${relative}`),
    ];
    return `Here're the files and directories up to 2 levels deep in ${shown}, excluding hidden items and node_modules:\n${lines.join('\n')}`;
  }

  async create(access: MemoryFileAccess, path: string, text: string): Promise<string> {
    const target = filePath(path);
    this.writable(access, path);
    writableText(text);
    await this.change(access, [target], async (current) => {
      if (current.has(target)) throw new MemoryFileError(`File ${path} already exists`);
      if ([...current.keys()].some((known) => under(known, target))) {
        throw new MemoryFileError(`File ${path} already exists`);
      }
      fileUnder(current, target, path);
      return [{ path: target, content: text }];
    });
    return `File created successfully at: ${path}`;
  }

  async strReplace(
    access: MemoryFileAccess,
    path: string,
    oldText: string,
    newText: string,
    expectedSha256?: string
  ): Promise<string> {
    const target = filePath(path);
    this.writable(access, path);
    writableText(newText);
    let snippet = '';
    await this.change(access, [target], async (current) => {
      const file = this.fileFor(current, target, path, expectedSha256);
      const lines = file.content.split('\n');
      const matching = lines.flatMap((line, at) => (line.includes(oldText) ? [at + 1] : []));
      if (matching.length === 0) {
        throw new MemoryFileError(
          `No replacement was performed, old_str \`${oldText}\` did not appear verbatim in ${path}.`
        );
      }
      if (matching.length > 1) {
        throw new MemoryFileError(
          `No replacement was performed. Multiple occurrences of old_str \`${oldText}\` in lines: ${matching.join(', ')}. Please ensure it is unique`
        );
      }
      const content = file.content.replace(oldText, () => newText);
      const changed = content.split('\n');
      const at = (matching[0] ?? 1) - 1;
      const start = Math.max(0, at - 2);
      snippet = numbered(changed.slice(start, Math.min(changed.length, at + 3)), start + 1);
      return [{ path: target, content }];
    });
    return `The memory file has been edited. Here is the snippet showing the change (with line numbers):\n${snippet}`;
  }

  async insert(
    access: MemoryFileAccess,
    path: string,
    line: number,
    text: string,
    expectedSha256?: string
  ): Promise<string> {
    const target = filePath(path);
    this.writable(access, path);
    writableText(text);
    await this.change(access, [target], async (current) => {
      const file = this.fileFor(current, target, path, expectedSha256);
      const lines = file.content.split('\n');
      if (!Number.isInteger(line) || line < 0 || line > lines.length) {
        throw new MemoryFileError(
          `Invalid \`insert_line\` parameter: ${line}. It should be within the range of lines of the file: [0, ${lines.length}]`
        );
      }
      lines.splice(line, 0, text.replace(/\n$/, ''));
      return [{ path: target, content: lines.join('\n') }];
    });
    return `The file ${path} has been edited.`;
  }

  async delete(access: MemoryFileAccess, path: string): Promise<string> {
    const target = memoryPath(path);
    this.writable(access, path);
    if (target === MEMORY_ROOT) {
      throw new MemoryFileError('Cannot delete the /memories directory itself');
    }
    await this.change(access, [target], async (current) => {
      const gone = [...current.keys()].filter((known) => under(known, target));
      if (gone.length === 0) throw new MemoryFileError(`The path ${path} does not exist`);
      return gone.map((known) => ({ path: known, content: null }));
    });
    return `Successfully deleted ${path}`;
  }

  async rename(access: MemoryFileAccess, oldPath: string, newPath: string): Promise<string> {
    const from = memoryPath(oldPath);
    const to = memoryPath(newPath);
    this.writable(access, oldPath);
    if (from === MEMORY_ROOT || to === MEMORY_ROOT || under(to, from)) {
      throw new MemoryFileError(`The destination ${newPath} already exists`);
    }
    await this.change(access, [from, to], async (current) => {
      if ([...current.keys()].some((known) => under(known, to))) {
        throw new MemoryFileError(`The destination ${newPath} already exists`);
      }
      fileUnder(current, to, newPath);
      const moved = [...current.values()].filter((file) => under(file.path, from));
      if (moved.length === 0) throw new MemoryFileError(`The path ${oldPath} does not exist`);
      return moved.flatMap((file) => {
        const path = `${to}${file.path.slice(from.length)}`;
        return [
          { path, content: file.content, renamedFrom: file.path, scopeOf: file.path },
          { path: file.path, content: null },
        ];
      });
    });
    return `Successfully renamed ${oldPath} to ${newPath}`;
  }

  /**
   * Replaces the content of every version of the files at `paths` (and under them) the access
   * sees with {@link REDACTED_CONTENT}, kept as redacted with `reason`, following renames back to
   * the paths a file had and on to the ones it got: what must not be kept is gone from the store,
   * while the history of changes stays. Returns the versions redacted.
   */
  async redact(
    access: MemoryFileAccess,
    paths: readonly string[],
    reason?: string
  ): Promise<number> {
    const all = unwrap(
      await this.adapter.findFileVersions({
        agentId: access.scope.agentId,
        visibleTo: access.visibleTo ?? access.scope,
      })
    );
    const roots = new Set(paths.map(memoryPath));
    const named = (path: string) => [...roots].some((root) => under(path, root) || path === root);
    const chain = new Set(
      all.filter((version) => named(version.path)).map((version) => version.path)
    );
    for (let grew = true; grew;) {
      grew = false;
      for (const version of all) {
        const from = version.renamedFrom;
        if (from === undefined) continue;
        if (chain.has(version.path) && !chain.has(from)) {
          chain.add(from);
          grew = true;
        } else if (chain.has(from) && !chain.has(version.path)) {
          chain.add(version.path);
          grew = true;
        }
      }
    }
    const versions = all.filter(
      (version) =>
        chain.has(version.path) && version.content !== null && version.redacted === undefined
    );
    if (versions.length === 0) return 0;
    unwrap(
      await this.adapter.redactFileVersions(
        versions.map((version) => version.id),
        {
          content: REDACTED_CONTENT,
          sha256: sha256Of(REDACTED_CONTENT),
          at: this.now(),
          ...(reason !== undefined && { reason }),
        }
      )
    );
    return versions.length;
  }

  /**
   * The files the access sees as a list for a context: each path with its size and first line,
   * at most `maxChars` characters, the rest counted
   */
  async index(access: MemoryFileAccess, maxChars = 2000): Promise<string | undefined> {
    const files = await this.list(access);
    if (files.length === 0) return undefined;
    const lines: string[] = [];
    let used = 0;
    for (const file of files) {
      const first = file.content.split('\n', 1)[0]?.trim() ?? '';
      const line = `- ${file.path} (${sizeOf(file.size)})${first ? `: ${first.slice(0, 120)}` : ''}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    const more = files.length - lines.length;
    return [
      'Memory files (view them with the memory tool):',
      ...lines,
      ...(more > 0 ? [`- and ${more} more`] : []),
    ].join('\n');
  }

  private sees(access: MemoryFileAccess, version: MemoryFileVersion): boolean {
    const place = access.place;
    const written = version.place;
    if (!place || !written) return true;
    return written.threadId !== place.threadId || place.pathIds.has(written.entryId);
  }

  /** Whether `a` stands over `b` for one path: a narrower scope, else a later version */
  private wins(a: MemoryFileVersion, b: MemoryFileVersion): boolean {
    const narrower = narrowness(a) - narrowness(b);
    if (narrower !== 0) return narrower > 0;
    return a.sequence !== b.sequence ? a.sequence > b.sequence : byFileVersion(a, b) > 0;
  }

  private fileOf(version: MemoryFileVersion): MemoryFile {
    const content = version.content ?? '';
    return {
      path: version.path,
      content,
      sha256: version.sha256 ?? sha256Of(content),
      size: Buffer.byteLength(content, 'utf8'),
      version,
    };
  }

  private writable(access: MemoryFileAccess, path: string): void {
    if (access.readOnly) throw new MemoryFileError(`The memory at ${path} is read-only`);
  }

  private fileFor(
    current: ReadonlyMap<string, MemoryFile>,
    target: string,
    path: string,
    expectedSha256: string | undefined
  ): MemoryFile {
    const file = current.get(target);
    if (!file) {
      if ([...current.keys()].some((known) => under(known, target))) {
        throw new MemoryFileError(`The path ${path} is not a file.`);
      }
      throw new MemoryFileError(`The path ${path} does not exist. Please provide a valid path.`);
    }
    if (expectedSha256 !== undefined && file.sha256 !== expectedSha256) {
      throw new MemoryFileError(
        `The file ${path} changed since it was viewed. View it again before you edit it.`
      );
    }
    return file;
  }

  /**
   * Makes a change under the lock of the agent: `plan` reads the files as they stand and names
   * the versions to add, which go after the newest version of each path in the access's scope.
   * When another process took a place first, the store refuses it and the change is planned
   * again on what stands then.
   */
  private async change(
    access: MemoryFileAccess,
    roots: readonly string[],
    plan: (current: ReadonlyMap<string, MemoryFile>) => Promise<PlannedWrite[]>
  ): Promise<void> {
    await this.exclusive(access.scope.agentId, async () => {
      for (let attempt = 1; ; attempt++) {
        const snapshot = unwrap(
          await this.adapter.findFileVersions({
            agentId: access.scope.agentId,
            visibleTo: access.visibleTo ?? access.scope,
          })
        );
        const current = new Map(this.filesOf(access, snapshot).map((file) => [file.path, file]));
        const writes = (await plan(current)).map((write) => ({
          ...write,
          scope: this.scopeFor(access, current.get(write.scopeOf ?? write.path)),
        }));
        const sequences = this.nextSequences(snapshot, writes);
        const conflict = await this.write(access, writes, current, sequences);
        if (!conflict) return;
        if (attempt >= WRITE_ATTEMPTS) {
          throw new MemoryFileError(
            `The memory at ${roots[0] ?? MEMORY_ROOT} is being changed by another writer. Try again.`
          );
        }
      }
    });
  }

  /**
   * Where a change of a path goes: the access's scope, or the narrower scope of the version the
   * run sees in front of it, so the change stands in front in its turn
   */
  private scopeFor(access: MemoryFileAccess, front: MemoryFile | undefined): MemoryItemScope {
    if (!front) return access.scope;
    return narrowness(front.version) > narrowness({ scope: access.scope })
      ? front.version.scope
      : access.scope;
  }

  /**
   * The next place of each path in its scope, after every version of it on any branch, read from
   * the same snapshot the change was planned on: a version another writer added since takes that
   * place, so the store refuses this change and it is planned again
   */
  private nextSequences(
    snapshot: readonly MemoryFileVersion[],
    writes: readonly { path: string; scope: MemoryItemScope }[]
  ): Map<string, number> {
    const next = new Map<string, number>(
      writes.map((write) => [fileKeyOf(write.scope, write.path), 1])
    );
    for (const version of snapshot) {
      const key = fileKeyOf(version.scope, version.path);
      const known = next.get(key);
      if (known !== undefined) next.set(key, Math.max(known, version.sequence + 1));
    }
    return next;
  }

  /** Adds the versions, all or none, true when the store refused them because a place was taken */
  private async write(
    access: MemoryFileAccess,
    writes: readonly (PlannedWrite & { scope: MemoryItemScope })[],
    current: ReadonlyMap<string, MemoryFile>,
    sequences: Map<string, number>
  ): Promise<boolean> {
    const at = this.now();
    const entryId = access.place?.entryId;
    const versions = writes.map((write): MemoryFileVersion => {
      const key = fileKeyOf(write.scope, write.path);
      const sequence = sequences.get(key) ?? 1;
      sequences.set(key, sequence + 1);
      return {
        id: `mf_${nanoid(16)}`,
        scope: write.scope,
        path: write.path,
        sequence,
        content: write.content,
        sha256: write.content === null ? null : sha256Of(write.content),
        previousId: current.get(write.path)?.version.id ?? null,
        ...(access.place &&
          entryId !== undefined && { place: { threadId: access.place.threadId, entryId } }),
        ...(write.renamedFrom !== undefined && { renamedFrom: write.renamedFrom }),
        author: access.author ?? 'model',
        createdAt: at,
      };
    });
    const put = await this.adapter.putFileVersions(versions);
    if (!put.success) {
      if (put.error === MEMORY_FILE_CONFLICT) return true;
      throw new Error(put.error);
    }
    for (const version of versions) access.observe?.(version.path, version.sha256);
    return false;
  }

  private async exclusive<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    let agents = writing.get(this.adapter);
    if (!agents) {
      agents = new Map();
      writing.set(this.adapter, agents);
    }
    const before = agents.get(agentId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    agents.set(agentId, settled);
    try {
      return await run;
    } finally {
      if (agents.get(agentId) === settled) agents.delete(agentId);
    }
  }
}
