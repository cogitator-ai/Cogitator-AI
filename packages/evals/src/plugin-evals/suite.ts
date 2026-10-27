import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { errorText, isDirectory, isFile, isInside, plainRelativePath, posixPath } from './files';
import { globMatches } from './glob';
import { loadMocks } from './mocks';
import {
  CaseYamlSchema,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUNS,
  DEFAULT_TIMEOUT_SECONDS,
  GraderSchema,
  isRecord,
  issuesText,
  PromptFrontmatterSchema,
  readMarkdown,
  readYaml,
  type CaseYaml,
  type PromptFrontmatter,
} from './schema';
import { parseTranscript } from './transcript';
import type {
  PluginEvalCase,
  PluginEvalGrader,
  PluginEvalTarget,
  PluginEvalToolMatcher,
} from './types';

/** A plugin eval run that cannot start: no plugin, no cases, a bad option */
export class PluginEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginEvalError';
  }
}

const CLAUDE_MANIFEST = join('.claude-plugin', 'plugin.json');
const COGITATOR_MANIFEST = join('.cogitator-plugin', 'plugin.json');
const CASE_FILES = ['prompt.md', 'case.yaml'] as const;

/** A case directory, loaded or with why it did not load */
export interface SuiteCase {
  name: string;
  /** The case directory relative to the eval directory */
  path: string;
  case?: PluginEvalCase;
  error?: string;
}

/** The plugin under test and the cases to run */
export interface LoadedSuite {
  pluginRoot: string;
  evalDir: string;
  /** Where `results/<timestamp>/` goes */
  resultsDir: string;
  /** The target named an installed plugin instead of a path */
  named: boolean;
  cases: SuiteCase[];
  warnings: string[];
}

export interface SuiteOptions {
  target?: string;
  cwd: string;
  evalDir?: string;
  caseGlob?: string;
  tags?: readonly string[];
  /** The install path of an installed plugin by `name` or `name@marketplace`, if there is one */
  installed: (id: string) => Promise<string | undefined>;
}

/** Whether `dir` holds a plugin manifest Cogitator reads */
export function isPluginRoot(dir: string): boolean {
  return isFile(join(dir, CLAUDE_MANIFEST)) || isFile(join(dir, COGITATOR_MANIFEST));
}

function enclosingPlugin(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    if (isPluginRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The `experimental.evals` of the plugin's manifests, Cogitator's over Claude Code's */
function manifestEvalDir(root: string): unknown {
  let found: unknown;
  for (const file of [CLAUDE_MANIFEST, COGITATOR_MANIFEST]) {
    const path = join(root, file);
    if (!isFile(path)) continue;
    try {
      const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(json) && isRecord(json.experimental) && json.experimental.evals !== undefined) {
        found = json.experimental.evals;
      }
    } catch {
      continue;
    }
  }
  return found;
}

function evalDirOf(root: string, flag: string | undefined, warnings: string[]): string {
  if (flag !== undefined) {
    const checked = plainRelativePath(flag);
    if ('problem' in checked) {
      throw new PluginEvalError(
        `--eval-dir ${flag} ${checked.problem}: give a relative path of plain directory names such as qa or quality/evals`
      );
    }
    return checked.path;
  }
  const fromManifest = manifestEvalDir(root);
  if (fromManifest === undefined) return 'evals';
  const value = Array.isArray(fromManifest) ? (fromManifest as unknown[])[0] : fromManifest;
  const checked =
    typeof value === 'string'
      ? plainRelativePath(value)
      : { problem: Array.isArray(fromManifest) ? 'has no path first' : 'is not a string' };
  if ('problem' in checked) {
    warnings.push(
      `Warning: experimental.evals ${JSON.stringify(fromManifest)} in plugin.json ${checked.problem}, using evals/`
    );
    return 'evals';
  }
  return checked.path;
}

/** Resolves the target, finds the eval directory and loads every case the filters keep */
export async function loadSuite(options: SuiteOptions): Promise<LoadedSuite> {
  const warnings: string[] = [];
  const target = options.target ?? '.';
  const path = resolve(options.cwd, target);
  let pluginRoot: string;
  let caseDir: string | undefined;
  let named = false;
  if (existsSync(path)) {
    if (isFile(path)) {
      if (!(CASE_FILES as readonly string[]).includes(basename(path))) {
        throw new PluginEvalError(`${target} is not a prompt.md or case.yaml file`);
      }
      caseDir = dirname(path);
      const root = enclosingPlugin(caseDir);
      if (!root) {
        throw new PluginEvalError(
          `No plugin encloses ${target}: no directory above it has ${CLAUDE_MANIFEST} or ${COGITATOR_MANIFEST}`
        );
      }
      pluginRoot = root;
    } else {
      if (!isPluginRoot(path)) {
        throw new PluginEvalError(
          `${target} is not a plugin directory: it has no ${CLAUDE_MANIFEST} or ${COGITATOR_MANIFEST}`
        );
      }
      pluginRoot = path;
    }
  } else if (/^[A-Za-z0-9][\w.-]*(?:@[\w.-]+)?$/.test(target)) {
    if (target.endsWith('@skills-dir')) {
      throw new PluginEvalError(
        `${target}: skills-directory plugins are not supported by Cogitator, pass the plugin directory instead`
      );
    }
    const installed = await options.installed(target);
    if (!installed) {
      throw new PluginEvalError(
        `No plugin directory or case file at ${target}, and no installed plugin is named ${target}`
      );
    }
    pluginRoot = installed;
    named = true;
  } else {
    throw new PluginEvalError(`No plugin directory or case file at ${target}`);
  }

  const evalRelative = evalDirOf(pluginRoot, options.evalDir, warnings);
  const evalDir = join(pluginRoot, evalRelative);
  const resultsDir = named
    ? join(resolve(options.cwd), evalRelative, 'results')
    : join(caseDir && !isInside(evalDir, caseDir) ? dirname(caseDir) : evalDir, 'results');
  const suiteMocks = join(evalDir, 'mocks');

  const caseDirs = caseDir ? [caseDir] : findCaseDirs(evalDir);
  const names = new Set<string>();
  const cases: SuiteCase[] = [];
  for (const dir of caseDirs) {
    const casePath = posixPath(relative(evalDir, dir)) || basename(dir);
    try {
      const loaded = loadCase(
        dir,
        casePath,
        pluginRoot,
        isInside(evalDir, dir) ? suiteMocks : undefined
      );
      if (!keep(loaded.name, loaded.tags, options)) continue;
      if (names.has(loaded.name)) {
        cases.push({
          name: loaded.name,
          path: casePath,
          error: `another case is also named ${loaded.name}`,
        });
        continue;
      }
      names.add(loaded.name);
      cases.push({ name: loaded.name, path: casePath, case: loaded });
    } catch (error) {
      const loose = looseIdentity(dir);
      if (!keep(loose.name, loose.tags, options)) continue;
      cases.push({ name: loose.name, path: casePath, error: errorText(error) });
    }
  }
  if (cases.length === 0) {
    const filtered = options.caseGlob !== undefined || (options.tags?.length ?? 0) > 0;
    throw new PluginEvalError(
      filtered
        ? `No eval cases found: no case under ${evalDir} matches the --case and --tag filters`
        : `No eval cases found under ${evalDir}: add <case>/prompt.md or <case>/case.yaml`
    );
  }
  return { pluginRoot, evalDir, resultsDir, named, cases, warnings };
}

/**
 * Whether the filters keep a case. `tags` is undefined for a case whose tags could not be read:
 * a tag filter keeps it, so a broken case still counts and fails the run
 */
function keep(name: string, tags: readonly string[] | undefined, options: SuiteOptions): boolean {
  if (options.caseGlob !== undefined && !globMatches(options.caseGlob, name)) return false;
  const wanted = options.tags ?? [];
  if (wanted.length === 0 || tags === undefined) return true;
  return tags.some((tag) => wanted.includes(tag));
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

/**
 * The name and tags of a case that did not load, as far as its files can still be read: the
 * `prompt.md` frontmatter over `case.yaml`, the directory name without either
 */
function looseIdentity(dir: string): { name: string; tags?: string[] } {
  let name: string | undefined;
  let rawTags: unknown;
  let readable = true;
  const yamlPath = join(dir, 'case.yaml');
  if (isFile(yamlPath)) {
    const parsed = readYaml(readFileSync(yamlPath, 'utf8'));
    if ('error' in parsed || !isRecord(parsed.value)) readable = false;
    else {
      if (typeof parsed.value.name === 'string') name = parsed.value.name;
      if (parsed.value.tags !== undefined) rawTags = parsed.value.tags;
    }
  }
  const promptPath = join(dir, 'prompt.md');
  if (isFile(promptPath)) {
    const parts = readMarkdown(readFileSync(promptPath, 'utf8'));
    if ('error' in parts) readable = false;
    else {
      if (typeof parts.fields.name === 'string') name = parts.fields.name;
      if (parts.fields.tags !== undefined) rawTags = parts.fields.tags;
    }
  }
  const tags = rawTags !== undefined ? stringList(rawTags) : readable ? [] : undefined;
  return { name: name?.trim() || basename(dir), ...(tags && { tags }) };
}

function isCaseDir(dir: string): boolean {
  return CASE_FILES.some((file) => isFile(join(dir, file)));
}

/** The case directories under the eval directory, sorted, not looking inside a case */
function findCaseDirs(evalDir: string): string[] {
  if (!isDirectory(evalDir)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      if (dir === evalDir && (entry === 'results' || entry === 'mocks')) continue;
      const full = join(dir, entry);
      if (!isDirectory(full)) continue;
      if (isCaseDir(full)) found.push(full);
      else walk(full);
    }
  };
  walk(evalDir);
  return found;
}

function readCaseYaml(dir: string): CaseYaml | undefined {
  const path = join(dir, 'case.yaml');
  if (!isFile(path)) return undefined;
  const parsed = readYaml(readFileSync(path, 'utf8'));
  if ('error' in parsed) throw new Error(`invalid case.yaml: ${parsed.error}`);
  const checked = CaseYamlSchema.safeParse(parsed.value ?? {});
  if (!checked.success) throw new Error(`invalid case.yaml: ${issuesText(checked.error)}`);
  return checked.data;
}

function readPrompt(dir: string): { fields: PromptFrontmatter; body: string } | undefined {
  const path = join(dir, 'prompt.md');
  if (!isFile(path)) return undefined;
  const parts = readMarkdown(readFileSync(path, 'utf8'));
  if ('error' in parts) throw new Error(`invalid prompt.md: ${parts.error}`);
  const checked = PromptFrontmatterSchema.safeParse(parts.fields);
  if (!checked.success)
    throw new Error(`invalid prompt.md frontmatter: ${issuesText(checked.error)}`);
  return { fields: checked.data, body: parts.body.trim() };
}

/** A file or directory a case names, which must stay inside the case directory */
function inCase(dir: string, path: string, field: string): string {
  const full = resolve(dir, path);
  if (isAbsolute(path) || !isInside(dir, full) || full === dir) {
    throw new Error(`invalid case.yaml: ${field} ${path} must be a path inside the case directory`);
  }
  return full;
}

/** Loads one case: its prompt, settings, graders, context and mocks */
export function loadCase(
  dir: string,
  path: string,
  pluginRoot: string,
  suiteMocks: string | undefined
): PluginEvalCase {
  const yaml = readCaseYaml(dir);
  const prompt = readPrompt(dir);
  const front = prompt?.fields ?? {};
  const execution = yaml?.execution ?? {};
  const text = prompt && prompt.body !== '' ? prompt.body : (execution.prompt?.trim() ?? '');
  if (text === '') {
    throw new Error(
      'the case has no prompt: write it as the body of prompt.md or as execution.prompt in case.yaml'
    );
  }

  const graders: PluginEvalGrader[] = [];
  for (const [index, entry] of (yaml?.graders ?? []).entries()) {
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new Error(`invalid case.yaml: graders.${index} needs a name`);
    }
    graders.push(graderOf(entry, entry.name.trim(), `graders.${index}`, dir));
  }
  const graderDir = join(dir, 'graders');
  if (isDirectory(graderDir)) {
    for (const file of readdirSync(graderDir).sort()) {
      if (!file.endsWith('.md') || file.startsWith('.')) continue;
      const parts = readMarkdown(readFileSync(join(graderDir, file), 'utf8'));
      if ('error' in parts) throw new Error(`invalid graders/${file}: ${parts.error}`);
      const body = parts.body.trim();
      const fields: Record<string, unknown> = { ...parts.fields };
      if (body !== '') {
        if (
          (fields.type === 'llm' || fields.type === 'baseline') &&
          fields.criteria === undefined
        ) {
          fields.criteria = body;
        }
        if (fields.type === 'regex' && fields.pattern === undefined) fields.pattern = body;
      }
      graders.push(graderOf(fields, file.slice(0, -'.md'.length), `graders/${file}`, dir));
    }
  }
  if (graders.length === 0) {
    throw new Error(
      'invalid case.yaml: graders: a case needs at least one grader, as graders/<name>.md or a graders: entry in case.yaml'
    );
  }
  const graderNames = new Set<string>();
  for (const grader of graders) {
    if (graderNames.has(grader.name)) throw new Error(`two graders are named ${grader.name}`);
    graderNames.add(grader.name);
  }

  const pluginPaths = front.plugins ?? yaml?.plugins;
  const plugins = pluginPaths
    ? pluginPaths.map((plugin) => {
        const full = resolve(dir, plugin);
        if (!isPluginRoot(full)) {
          throw new Error(`plugins: ${plugin} is not a plugin directory (from the case directory)`);
        }
        return full;
      })
    : [pluginRoot];

  const context = yaml?.context ?? {};
  const scaffoldScript =
    context.scaffold_script === undefined
      ? undefined
      : inCase(dir, context.scaffold_script, 'context.scaffold_script');
  if (scaffoldScript && !isFile(scaffoldScript)) {
    throw new Error(
      `invalid case.yaml: context.scaffold_script ${context.scaffold_script} does not exist`
    );
  }
  const historyFile =
    context.history_file === undefined
      ? undefined
      : inCase(dir, context.history_file, 'context.history_file');
  if (historyFile) {
    if (!isFile(historyFile)) {
      throw new Error(
        `invalid case.yaml: context.history_file ${context.history_file} does not exist`
      );
    }
    const parsed = parseTranscript(readFileSync(historyFile, 'utf8'));
    if ('error' in parsed) {
      throw new Error(
        `invalid case.yaml: context.history_file ${context.history_file}: ${parsed.error}`
      );
    }
  }
  const addDirs = (context.add_dirs ?? []).map((added) => {
    const checked = plainRelativePath(added);
    if ('problem' in checked) {
      throw new Error(`invalid case.yaml: context.add_dirs ${added} ${checked.problem}`);
    }
    if (!isDirectory(join(dir, checked.path))) {
      throw new Error(
        `invalid case.yaml: context.add_dirs ${added} is not a directory of the case`
      );
    }
    return checked.path;
  });

  let mocks: ReturnType<typeof loadMocks>;
  try {
    mocks = loadMocks(suiteMocks, dir);
  } catch (error) {
    throw new Error(`invalid mock: ${errorText(error)}`, { cause: error });
  }

  const name = front.name ?? yaml?.name ?? basename(dir);
  const description = front.description ?? yaml?.description;
  const expectedOutcome = front.expected_outcome ?? yaml?.expected_outcome;
  const model = front.model ?? execution.model;
  const appendSystemPrompt = front.append_system_prompt ?? execution.append_system_prompt;
  return {
    name,
    dir,
    path,
    ...(description !== undefined && { description }),
    ...(expectedOutcome !== undefined && { expectedOutcome }),
    tags: front.tags ?? yaml?.tags ?? [],
    plugins,
    runs: front.runs ?? yaml?.runs ?? DEFAULT_RUNS,
    ...(model !== undefined && { model }),
    maxTurns: front.max_turns ?? execution.max_turns ?? DEFAULT_MAX_TURNS,
    timeoutSeconds: front.timeout_seconds ?? execution.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    allowedTools: front.allowed_tools ?? execution.allowed_tools ?? [],
    ...(appendSystemPrompt !== undefined && { appendSystemPrompt }),
    env: { ...execution.env, ...front.env },
    prompt: text,
    context: {
      ...(scaffoldScript && { scaffoldScript }),
      ...(historyFile && { historyFile }),
      addDirs,
    },
    graders,
    mocks: mocks.mocks,
    mockProblems: mocks.problems,
  };
}

function matcherOf(
  value: string | { tool: string; input_match?: string | undefined }
): PluginEvalToolMatcher {
  if (typeof value === 'string') return { tool: value };
  return value.input_match === undefined
    ? { tool: value.tool }
    : { tool: value.tool, inputMatch: value.input_match };
}

function workspacePathProblem(path: string): string | undefined {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  const outside =
    isAbsolute(path) || normalized === '.' || normalized === '..' || normalized.startsWith('../');
  return outside ? 'must be a path inside the workspace' : undefined;
}

function graderOf(
  fields: Record<string, unknown>,
  name: string,
  where: string,
  dir: string
): PluginEvalGrader {
  const parsed = GraderSchema.safeParse({ ...fields, name });
  if (!parsed.success) throw new Error(`invalid ${where}: ${issuesText(parsed.error)}`);
  const grader = parsed.data;
  const base = {
    name,
    weight: grader.weight,
    ...(grader.arm !== undefined && { arm: grader.arm }),
  };
  switch (grader.type) {
    case 'regex': {
      const target: PluginEvalTarget = grader.target;
      if (typeof target === 'object') {
        const problem = workspacePathProblem(target.path);
        if (problem) throw new Error(`invalid ${where}: target.path ${problem}`);
      }
      return {
        ...base,
        type: 'regex',
        pattern: grader.pattern,
        flags: grader.flags,
        match: grader.match,
        target,
      };
    }
    case 'tool_used':
      if (grader.max !== undefined && grader.max < grader.min) {
        throw new Error(`invalid ${where}: max is below min`);
      }
      return {
        ...base,
        type: 'tool_used',
        tool: grader.tool,
        ...(grader.input_match !== undefined && { inputMatch: grader.input_match }),
        min: grader.min,
        ...(grader.max !== undefined && { max: grader.max }),
      };
    case 'tool_order':
      return {
        ...base,
        type: 'tool_order',
        before: matcherOf(grader.before),
        after: matcherOf(grader.after),
      };
    case 'file_exists':
      return { ...base, type: 'file_exists', path: grader.path, exists: grader.exists };
    case 'llm': {
      const focus: PluginEvalTarget = grader.focus;
      if (typeof focus === 'object') {
        const problem = workspacePathProblem(focus.path);
        if (problem) throw new Error(`invalid ${where}: focus.path ${problem}`);
      }
      return { ...base, type: 'llm', criteria: grader.criteria, focus };
    }
    case 'baseline': {
      const file = inCase(dir, grader.baseline_file, `${where} baseline_file`);
      if (!file.endsWith('.jsonl') || !isFile(file)) {
        throw new Error(
          `invalid ${where}: baseline_file ${grader.baseline_file} must be a .jsonl file of the case directory`
        );
      }
      const parsed = parseTranscript(readFileSync(file, 'utf8'));
      if ('error' in parsed) {
        throw new Error(`invalid ${where}: baseline_file ${grader.baseline_file}: ${parsed.error}`);
      }
      return {
        ...base,
        type: 'baseline',
        baselineFile: grader.baseline_file,
        criteria: grader.criteria,
      };
    }
  }
}
