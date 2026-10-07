import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { unifiedDiff } from './diff.js';
import { AGENT_RULES_BEGIN, AGENT_RULES_END } from './emit.js';
import {
  applyOps,
  applyYamlOps,
  deepEqual,
  formatPath,
  merge3,
  parseStructured,
  structuredFormat,
  type MergeOp,
} from './merge.js';
import { MANIFEST_KEY, planProject, type ProjectPlan } from './plan.js';
import type { EnvVar } from './project.js';
import {
  formatProject,
  hashContent,
  installDependencies,
  readLock,
  silentLogger,
  updateLock,
  type ScaffoldLock,
  type ScaffoldLogger,
  type StepResult,
} from './scaffold.js';
import {
  parseSpec,
  type ChannelKind,
  type CodingAgent,
  type DeployTarget,
  type FeatureId,
  type MemoryKind,
  type ProjectSpec,
  type VectorStore,
} from './spec.js';
import { scaffolderVersion } from './versions.js';

/** What `cogitator add` brings into a project. Lists are added to, the rest replaced. */
export interface AddChanges {
  features?: readonly FeatureId[];
  channels?: readonly ChannelKind[];
  codingAgents?: readonly CodingAgent[];
  memory?: MemoryKind;
  vectorStore?: VectorStore;
  deploy?: DeployTarget;
}

/** A file `cogitator add` writes or removes, with the diff against what is on disk. */
export interface FileChange {
  path: string;
  kind: 'create' | 'update' | 'delete';
  /** The new content, absent for a deletion. */
  content?: string;
  /** How the content came about: generated as a whole, or merged into the user's copy. */
  source: 'generated' | 'merged';
  diff: string;
}

/** Something the addition left as it is on purpose. */
export interface AddNote {
  message: string;
  path?: string;
  /** The change that was not applied, when there is one. */
  diff?: string;
}

/** A file the user changed in a way the addition cannot be merged into. */
export interface AddConflict {
  path: string;
  reason: string;
  /** The change the addition needs to make to the file as generated. */
  diff: string;
}

export interface AddPlan {
  directory: string;
  from: ProjectSpec;
  to: ProjectSpec;
  /** What changes in the spec, one item per line: `feature rag`, `memory sqlite -> postgres`. */
  summary: string[];
  changes: FileChange[];
  conflicts: AddConflict[];
  /** What was left as it is on purpose, and why. */
  notes: AddNote[];
  /** Dependencies the project gains or whose version changes. */
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** Dependencies and dev dependencies the merged package.json no longer lists. */
  removedDependencies: string[];
  /** Environment variables the project starts reading. */
  env: EnvVar[];
  /** Compose services the project starts using. */
  services: string[];
  warnings: string[];
  /** The command that creates the project as it is after the addition. */
  command: string;
  /** Whether the project already has everything asked for. */
  upToDate: boolean;
}

export interface AddOptions {
  /** Install when the dependencies change (default `true`). */
  install?: boolean;
  log?: ScaffoldLogger;
  /** Show the install's output live instead of capturing it. */
  inheritOutput?: boolean;
}

export interface AddResult {
  plan: AddPlan;
  /** Files written, relative to the project. */
  written: string[];
  deleted: string[];
  install: StepResult;
  format: StepResult;
}

/** Thrown when the project is not one the scaffolder generated, so its parts are unknown. */
export class NotAScaffoldedProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAScaffoldedProjectError';
  }
}

/** Thrown when an addition would overwrite changes the user made. Nothing is written. */
export class AddConflictError extends Error {
  readonly conflicts: AddConflict[];

  constructor(conflicts: AddConflict[]) {
    super(
      [
        `cogitator add would overwrite your changes to ${conflicts.length} file${conflicts.length === 1 ? '' : 's'}, so nothing was written:`,
        ...conflicts.map((conflict) => `- ${conflict.path}: ${conflict.reason}`),
        'Apply the changes below by hand, or commit your edits elsewhere and restore the generated files, then run cogitator add again.',
      ].join('\n')
    );
    this.name = 'AddConflictError';
    this.conflicts = conflicts;
  }
}

interface ProjectState {
  manifest: Record<string, unknown>;
  spec: ProjectSpec;
  packageManagerSpec?: string;
  generator?: string;
}

function readProject(directory: string): ProjectState {
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new NotAScaffoldedProjectError(
      `There is no package.json in ${directory}: run cogitator add in the root of the project`
    );
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new NotAScaffoldedProjectError(`${manifestPath} is not a package manifest`);
  }
  const record = manifest as Record<string, unknown>;
  const stored = record[MANIFEST_KEY];
  if (typeof stored === 'object' && stored !== null && 'example' in stored && !('spec' in stored)) {
    throw new NotAScaffoldedProjectError(
      `${directory} was created from an example, not generated from a spec, so cogitator add cannot extend it. Generate a project with the features you need instead: npx create-cogitator-app`
    );
  }
  if (typeof stored !== 'object' || stored === null || !('spec' in stored)) {
    throw new NotAScaffoldedProjectError(
      `${directory} was not created by create-cogitator-app: its package.json has no "${MANIFEST_KEY}" field, so cogitator add cannot tell what the project contains`
    );
  }
  const spec = parseSpec(stored.spec);
  const generator =
    'generator' in stored && typeof stored.generator === 'string' ? stored.generator : undefined;
  const packageManagerSpec =
    typeof record.packageManager === 'string' ? record.packageManager : undefined;
  return { manifest: record, spec, packageManagerSpec, generator };
}

function withChanges(spec: ProjectSpec, changes: AddChanges): ProjectSpec {
  return parseSpec({
    ...spec,
    features: [...spec.features, ...(changes.features ?? [])],
    channels: [...spec.channels, ...(changes.channels ?? [])],
    codingAgents: [...spec.codingAgents, ...(changes.codingAgents ?? [])],
    ...(changes.memory && { memory: changes.memory }),
    ...(changes.vectorStore && { vectorStore: changes.vectorStore }),
    ...(changes.deploy && { deploy: changes.deploy }),
  });
}

function describeChanges(from: ProjectSpec, to: ProjectSpec): string[] {
  const added = <T>(before: readonly T[], after: readonly T[]) =>
    after.filter((item) => !before.includes(item));
  return [
    ...added(from.features, to.features).map((feature) => `feature ${feature}`),
    ...added(from.channels, to.channels).map((channel) => `channel ${channel}`),
    ...added(from.codingAgents, to.codingAgents).map((agent) => `coding agent ${agent}`),
    ...(from.memory !== to.memory ? [`memory ${from.memory} -> ${to.memory}`] : []),
    ...(from.vectorStore !== to.vectorStore
      ? [`vector store ${from.vectorStore} -> ${to.vectorStore}`]
      : []),
    ...(from.deploy !== to.deploy ? [`deploy ${from.deploy} -> ${to.deploy}`] : []),
  ];
}

function changedEntries(
  before: Record<string, string>,
  after: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(after).filter(([name, value]) => before[name] !== value)
  );
}

/** Names under `dependencies` and `devDependencies` of a package.json text. */
function dependencyNames(text: string | undefined): Set<string> {
  if (text === undefined) return new Set();
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    const names = (field: unknown) =>
      field && typeof field === 'object' && !Array.isArray(field) ? Object.keys(field) : [];
    return new Set([...names(manifest.dependencies), ...names(manifest.devDependencies)]);
  } catch {
    return new Set();
  }
}

/**
 * Whether the addition changes what the project depends on, in either
 * direction: the lockfile and the installed tree need an install either way.
 */
export function changesDependencies(plan: AddPlan): boolean {
  return (
    Object.keys(plan.dependencies).length > 0 ||
    Object.keys(plan.devDependencies).length > 0 ||
    plan.removedDependencies.length > 0
  );
}

/** Keys of package.json the scaffolder owns: they always take the generated value. */
const OWNED_MANIFEST_KEYS = new Set([MANIFEST_KEY]);

/** Maps whose keys are kept sorted, the way package managers write them. */
const SORTED_MANIFEST_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function sortManifest(manifest: unknown): unknown {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return manifest;
  const record = manifest as Record<string, unknown>;
  for (const key of SORTED_MANIFEST_MAPS) {
    const map = record[key];
    if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
      record[key] = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
    }
  }
  return record;
}

function withoutOwned(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !OWNED_MANIFEST_KEYS.has(key)));
}

type Decision =
  | { kind: 'none' }
  | { kind: 'change'; change: Omit<FileChange, 'diff'> }
  | { kind: 'conflict'; reason: string }
  | { kind: 'note'; message: string; withDiff?: boolean };

interface FileInputs {
  path: string;
  base: string | undefined;
  theirs: string | undefined;
  ours: string | undefined;
  /** Whether the file on disk is exactly what the scaffolder wrote. */
  pristine: boolean;
}

function textDecision({ path, base, theirs, ours, pristine }: FileInputs): Decision {
  if (theirs === undefined) {
    if (ours === undefined) return { kind: 'none' };
    if (pristine) return { kind: 'change', change: { path, kind: 'delete', source: 'generated' } };
    return { kind: 'note', message: 'no longer generated, kept because you edited it' };
  }
  if (ours === theirs) return { kind: 'none' };
  if (ours === undefined) {
    if (base === undefined) {
      return {
        kind: 'change',
        change: { path, kind: 'create', content: theirs, source: 'generated' },
      };
    }
    return { kind: 'conflict', reason: 'you deleted it, and the addition changes it' };
  }
  if (base === undefined) {
    return { kind: 'conflict', reason: 'a file of yours is in the way of a new generated file' };
  }
  if (pristine) {
    return {
      kind: 'change',
      change: { path, kind: 'update', content: theirs, source: 'generated' },
    };
  }
  return { kind: 'conflict', reason: 'you edited it, and the addition changes it' };
}

function structuredDecision(inputs: FileInputs): Decision | undefined {
  const { path, base, theirs, ours } = inputs;
  const format = structuredFormat(path);
  if (!format || base === undefined || theirs === undefined || ours === undefined) return undefined;
  const parsed = [base, ours, theirs].map((text) => parseStructured(format, text));
  if (parsed.some((value) => value === undefined)) return undefined;
  const [baseValue, oursValue, theirsValue] = parsed;

  const manifest = path === 'package.json';
  const outcome = manifest
    ? merge3(withoutOwned(baseValue), withoutOwned(oursValue), withoutOwned(theirsValue))
    : merge3(baseValue, oursValue, theirsValue);
  if (outcome.conflicts.length > 0) {
    return {
      kind: 'conflict',
      reason: `you changed ${outcome.conflicts.map(formatPath).join(', ')}, and the addition changes it differently`,
    };
  }
  const ops: MergeOp[] = [...outcome.ops];
  if (manifest && typeof theirsValue === 'object' && theirsValue !== null) {
    for (const key of OWNED_MANIFEST_KEYS) {
      const value: unknown = (theirsValue as Record<string, unknown>)[key];
      const current: unknown =
        typeof oursValue === 'object' && oursValue !== null
          ? (oursValue as Record<string, unknown>)[key]
          : undefined;
      if (!deepEqual(value, current)) ops.push({ kind: 'set', path: [key], value });
    }
  }
  if (ops.length === 0) return { kind: 'none' };

  let content: string;
  if (format === 'json') {
    const merged = applyOps(oursValue, ops);
    content = JSON.stringify(manifest ? sortManifest(merged) : merged, null, 2) + '\n';
  } else {
    const doc = parseDocument(ours);
    applyYamlOps(doc, ops);
    content = doc.toString();
  }
  if (content === ours) return { kind: 'none' };
  return { kind: 'change', change: { path, kind: 'update', content, source: 'merged' } };
}

/** The managed block of AGENTS.md, from its begin marker through its end marker. */
function agentRules(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(AGENT_RULES_BEGIN);
  const endMarker = text.indexOf(AGENT_RULES_END, start);
  if (start === -1 || endMarker === -1) return undefined;
  return { start, end: endMarker + AGENT_RULES_END.length };
}

function agentsMdDecision(inputs: FileInputs): Decision {
  const { path, theirs, ours } = inputs;
  if (ours === undefined || theirs === undefined) return textDecision(inputs);
  const mine = agentRules(ours);
  const generated = agentRules(theirs);
  if (!mine || !generated) {
    return {
      kind: 'note',
      message: `the ${AGENT_RULES_BEGIN} block is gone, so the rules for coding agents were not updated`,
      withDiff: true,
    };
  }
  const content =
    ours.slice(0, mine.start) + theirs.slice(generated.start, generated.end) + ours.slice(mine.end);
  if (content === ours) return { kind: 'none' };
  return { kind: 'change', change: { path, kind: 'update', content, source: 'merged' } };
}

function lines(text: string | undefined): string[] {
  return (text ?? '').split('\n').filter((line) => line.trim() !== '');
}

function gitignoreDecision(inputs: FileInputs): Decision {
  const { path, base, theirs, ours } = inputs;
  if (ours === undefined || theirs === undefined) return textDecision(inputs);
  const present = new Set(lines(ours).map((line) => line.trim()));
  const before = new Set(lines(base).map((line) => line.trim()));
  const added = lines(theirs).filter(
    (line) => !before.has(line.trim()) && !present.has(line.trim())
  );
  if (added.length === 0) return { kind: 'none' };
  const content = `${ours.replace(/\n*$/, '\n')}${added.join('\n')}\n`;
  return { kind: 'change', change: { path, kind: 'update', content, source: 'merged' } };
}

/** README.md is the user's to rewrite: an edited one is left alone with a note instead of a conflict. */
function readmeDecision(inputs: FileInputs): Decision {
  const decision = textDecision(inputs);
  if (decision.kind !== 'conflict') return decision;
  return {
    kind: 'note',
    message: 'has your edits and was left as it is, the generated change is not applied',
    withDiff: true,
  };
}

function decide(inputs: FileInputs): Decision {
  if (inputs.pristine) return textDecision(inputs);
  if (inputs.path === 'AGENTS.md') return agentsMdDecision(inputs);
  if (inputs.path === '.gitignore') return gitignoreDecision(inputs);
  if (inputs.path === 'README.md') return readmeDecision(inputs);
  return structuredDecision(inputs) ?? textDecision(inputs);
}

function readText(directory: string, path: string): string | undefined {
  const full = join(directory, path);
  return existsSync(full) ? readFileSync(full, 'utf-8') : undefined;
}

function fileMap(plan: ProjectPlan): Map<string, string> {
  return new Map(
    plan.files.filter((file) => file.mode === undefined).map((file) => [file.path, file.content])
  );
}

/**
 * What adding `changes` to the project in `directory` would do, without
 * writing anything. The project's spec is read from package.json, both the
 * project as it is and as it would be are planned, and what the addition
 * changes between them is merged into the files on disk. A file the user
 * edited takes the change when it can be merged key by key (package.json,
 * cogitator.yml, docker-compose.yml, the managed block of AGENTS.md,
 * .gitignore), and is a conflict otherwise.
 */
export function planAdd(directory: string, changes: AddChanges): AddPlan {
  const root = resolve(directory);
  const project = readProject(root);
  const from = project.spec;
  const to = withChanges(from, changes);
  const options = { packageManagerSpec: project.packageManagerSpec };
  const before = planProject(from, options);
  const after = planProject(to, options);

  const notes: AddNote[] = [];
  const version = scaffolderVersion();
  if (project.generator && project.generator !== `create-cogitator-app@${version}`) {
    notes.push({
      message: `The project was created by ${project.generator}, the added files come from create-cogitator-app@${version}`,
    });
  }
  const lock: ScaffoldLock | undefined = readLock(root);
  if (!lock) {
    notes.push({
      message:
        'There is no .cogitator/scaffold.json, so every existing file the addition changes counts as edited by you',
    });
  }

  const upToDate = deepEqual(from, to);
  const changesOut: FileChange[] = [];
  const conflicts: AddConflict[] = [];
  if (!upToDate) {
    const baseFiles = fileMap(before);
    const theirFiles = fileMap(after);
    const paths = [...new Set([...baseFiles.keys(), ...theirFiles.keys()])].sort();
    for (const path of paths) {
      const base = baseFiles.get(path);
      const theirs = theirFiles.get(path);
      if (base === theirs) continue;
      const ours = readText(root, path);
      const locked = lock?.files[path];
      const pristine =
        ours !== undefined &&
        (ours === base || (locked !== undefined && hashContent(ours) === locked));
      const decision = decide({ path, base, theirs, ours, pristine });
      if (decision.kind === 'change') {
        changesOut.push({
          ...decision.change,
          diff: unifiedDiff(path, ours, decision.change.content),
        });
      } else if (decision.kind === 'conflict') {
        conflicts.push({ path, reason: decision.reason, diff: unifiedDiff(path, base, theirs) });
      } else if (decision.kind === 'note') {
        notes.push({
          path,
          message: decision.message,
          ...(decision.withDiff && { diff: unifiedDiff(path, base, theirs) }),
        });
      }
    }
  }

  const manifest = changesOut.find((change) => change.path === 'package.json');
  const remaining = dependencyNames(manifest?.content);
  const removedDependencies = manifest
    ? [...dependencyNames(readText(root, 'package.json'))]
        .filter((name) => !remaining.has(name))
        .sort()
    : [];
  const knownEnv = new Set(before.env.map((variable) => variable.name));
  return {
    directory: root,
    from,
    to,
    summary: describeChanges(from, to),
    changes: changesOut,
    conflicts,
    notes,
    dependencies: changedEntries(before.dependencies, after.dependencies),
    devDependencies: changedEntries(before.devDependencies, after.devDependencies),
    removedDependencies,
    env: after.env.filter((variable) => !knownEnv.has(variable.name)),
    services: after.services.filter((service) => !before.services.includes(service)),
    warnings: after.warnings.filter((warning) => !before.warnings.includes(warning)),
    command: after.command,
    upToDate,
  };
}

/** Extensions Biome formats in a generated project. */
const FORMATTED = /\.(?:[cm]?[jt]sx?|json|css)$/;

/**
 * Adds `changes` to the project in `directory`: plans the addition, refuses
 * with an `AddConflictError` when it would overwrite the user's edits, then
 * writes the files, installs new dependencies, formats what it wrote and
 * records the new spec and file hashes. Adding what the project already has
 * changes nothing.
 */
export async function addToProject(
  directory: string,
  changes: AddChanges,
  options: AddOptions = {}
): Promise<AddResult> {
  const log = options.log ?? silentLogger;
  const plan = planAdd(directory, changes);
  const skipped = (reason: string): StepResult => ({ status: 'skipped', reason });
  if (plan.upToDate) {
    return {
      plan,
      written: [],
      deleted: [],
      install: skipped('nothing was added'),
      format: skipped('nothing was added'),
    };
  }
  if (plan.conflicts.length > 0) throw new AddConflictError(plan.conflicts);

  log.start('Updating project files');
  const written: string[] = [];
  const deleted: string[] = [];
  for (const change of plan.changes) {
    const target = join(plan.directory, change.path);
    if (change.kind === 'delete') {
      await rm(target, { force: true });
      deleted.push(change.path);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, change.content ?? '');
      written.push(change.path);
    }
  }
  log.done(`Updated ${written.length + deleted.length} files`);

  const dependenciesChanged = changesDependencies(plan);
  let install = dependenciesChanged
    ? skipped('install was turned off')
    : skipped('the dependencies did not change');
  if (dependenciesChanged && options.install !== false) {
    log.start(`Installing the dependencies with ${plan.to.packageManager}`);
    install = await installDependencies(
      plan.directory,
      plan.to.packageManager,
      options.inheritOutput ?? false
    );
    if (install.status === 'done') log.done('Installed the dependencies');
    else log.fail('Could not install the dependencies');
  }

  const format = await formatProject(
    plan.directory,
    written.filter((path) => FORMATTED.test(path))
  );
  if (format.status === 'failed') log.warn(format.error.message);

  await updateLock(plan.directory, [...written, ...deleted]);
  return { plan, written, deleted, install, format };
}
