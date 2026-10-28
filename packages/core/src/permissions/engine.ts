/**
 * `resolvePermission`: the one place a tool call is allowed, asked about or refused, by the rules
 * of every layer and the run's mode
 */

import { basename, isAbsolute, posix, relative, resolve } from 'node:path';
import type {
  PermissionBehavior,
  PermissionClassification,
  PermissionDecision,
  PermissionLayer,
  PermissionLayerSettings,
  PermissionMode,
  PermissionRuleRef,
  Tool,
  Workspace,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { isPathAllowed } from '../tools/path-guard';
import {
  compilePathPattern,
  normalizeRulePath,
  foldPath,
  pathMatches,
  pathsIgnoreCase,
  patternReachesInto,
  resolveCallPath,
  type PathPattern,
  type ResolvedPath,
} from './paths';
import {
  accessKindOf,
  isUnmappedClaudeName,
  parameterMatches,
  parameterSpecifier,
  parseRule,
  ruleTarget,
  targetCovers,
  type AccessKind,
  type ParsedRule,
  type RuleTarget,
} from './rules';
import {
  assignsOnlySafeVariables,
  editCommandPaths,
  filesOf,
  isReadOnlyCommand,
  isSafeVariable,
  matchesCommandPattern,
  parseCommandLine,
  type ParsedCommandLine,
  type ShellCommand,
} from './shell';
import { own } from '../utils/own';
import {
  commandWorkspace,
  criticalRemoval,
  plainForSandbox,
  removesOutside,
  sandboxedCall,
} from './sandbox';

const BEHAVIORS: readonly PermissionBehavior[] = ['deny', 'ask', 'allow'];

/** A rule of a layer, read and ready to match */
interface CompiledRule {
  ref: PermissionRuleRef;
  parsed: ParsedRule;
  target: RuleTarget;
  /** Where its `/path` patterns start from */
  anchor?: string;
  /** Where its relative path patterns start from, instead of the call's working directory */
  cwd?: string;
  /** The rules of the same list, for `!` patterns, and its place there */
  list: CompiledRule[];
  index: number;
}

/**
 * The rules of every layer, read once: `deny`, `ask` and `allow` rules, each with the layer and
 * the file it came from. A rule that cannot be read is left out, with why in `warnings`
 */
export class PermissionRuleSet {
  readonly warnings: string[] = [];
  private readonly byBehavior: Record<PermissionBehavior, CompiledRule[]> = {
    deny: [],
    ask: [],
    allow: [],
  };

  constructor(readonly layers: readonly PermissionLayerSettings[]) {
    const managedOnly = layers.some(
      (layer) => layer.layer === 'managed' && layer.allowManagedPermissionRulesOnly === true
    );
    for (const layer of [...layers].sort(byLayer)) {
      if (managedOnly && layer.layer !== 'managed') continue;
      for (const behavior of BEHAVIORS) {
        const list: CompiledRule[] = [];
        for (const text of layer[behavior] ?? []) {
          const parsed = parseRule(text);
          if ('error' in parsed) {
            this.warnings.push(`${where(layer)}: ${parsed.error}, the rule is ignored`);
            continue;
          }
          const target = ruleTarget(parsed, behavior);
          if ('error' in target) {
            this.warnings.push(`${where(layer)}: ${target.error}, the rule is ignored`);
            continue;
          }
          if (isUnmappedClaudeName(parsed.tool)) {
            this.warnings.push(
              `${where(layer)}: ${parsed.text} names a Claude Code tool Cogitator has no counterpart for, it matches no tool`
            );
          }
          list.push({
            ref: {
              rule: parsed.text,
              behavior,
              layer: layer.layer,
              ...(layer.origin !== undefined && { origin: layer.origin }),
            },
            parsed,
            target,
            ...(layer.anchor !== undefined && { anchor: layer.anchor }),
            ...(layer.cwd !== undefined && { cwd: layer.cwd }),
            list,
            index: list.length,
          });
        }
        this.byBehavior[behavior].push(...list);
      }
    }
  }

  rules(behavior: PermissionBehavior): readonly CompiledRule[] {
    return this.byBehavior[behavior];
  }

  /** Whether any layer has a rule at all */
  get empty(): boolean {
    return BEHAVIORS.every((behavior) => this.byBehavior[behavior].length === 0);
  }

  /** The directories `acceptEdits` treats as inside, from every layer */
  get additionalDirectories(): string[] {
    return this.layers.flatMap((layer) =>
      (layer.additionalDirectories ?? []).map((dir) =>
        isAbsolute(dir) ? dir : resolve(layer.anchor ?? process.cwd(), dir)
      )
    );
  }

  /** Whether a `deny` rule without a specifier names `tool`, so the model is not offered it */
  deniesWhole(tool: Tool): boolean {
    return this.byBehavior.deny.some(
      (rule) => rule.parsed.specifier === undefined && targetCovers(rule.target, tool)
    );
  }

  /** Whether a layer keeps `mode` from being used (`disableBypassPermissionsMode`, `disableAutoMode`) */
  disables(mode: PermissionMode): boolean {
    if (mode === 'bypassPermissions') {
      return this.layers.some((layer) => layer.disableBypassPermissionsMode === 'disable');
    }
    if (mode === 'auto') return this.layers.some((layer) => layer.disableAutoMode === 'disable');
    return false;
  }

  /**
   * The `defaultMode` of the highest layer that sets one. Project and local files cannot set
   * `auto` or `bypassPermissions`, as in Claude Code: a repository must not turn prompts off
   */
  defaultMode(): PermissionMode | undefined {
    for (const layer of [...this.layers].sort(byLayer)) {
      const mode = layer.defaultMode;
      if (mode === undefined) continue;
      if (
        (layer.layer === 'project' || layer.layer === 'local') &&
        (mode === 'auto' || mode === 'bypassPermissions')
      ) {
        continue;
      }
      if (this.disables(mode)) continue;
      return mode;
    }
    return undefined;
  }
}

const LAYER_ORDER: Record<PermissionLayer, number> = {
  managed: 0,
  session: 1,
  local: 2,
  project: 3,
  user: 4,
};

function byLayer(a: PermissionLayerSettings, b: PermissionLayerSettings): number {
  return LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer];
}

function where(layer: PermissionLayerSettings): string {
  return layer.origin ? `${layer.layer} settings (${layer.origin})` : `${layer.layer} rules`;
}

/** What `resolvePermission` decides a call with */
export interface PermissionContext {
  mode: PermissionMode;
  rules: PermissionRuleSet;
  /** Whether the call needs approval without any rule: its tool's `requiresApproval`, the guardrails */
  needsApproval: boolean;
  /**
   * Whether the guardrails (not the tool's own setting) make the call need approval: a command
   * that runs in the workspace's OS sandbox skips only the tool's own approval
   */
  guardrailsApproval?: boolean;
  /**
   * Whether removals ask as an agent's tool calls do: an `rm` or `rmdir` of a critical path in
   * every mode, and a removal outside the workspace by a command no sandbox confines in every mode
   * but `bypassPermissions` (default true). The capability checks of plugin hooks turn it off, so
   * their commands keep running as in Claude Code
   */
  removalChecks?: boolean;
  /** The run's workspace: relative paths of calls start from its root, `acceptEdits` keeps inside it */
  workspace?: Workspace;
  /** The working directory without a workspace (default: the process's) */
  cwd?: string;
  /** Where `/path` patterns of `session` rules start from (default: the working directory) */
  projectRoot?: string;
  /** Tools of the run `plan` mode runs although they are not read-only, such as its `exit_plan_mode` */
  planTools?: ReadonlySet<Tool>;
  /** Decides a call that would ask in `auto` mode */
  classify?: (reason: string) => Promise<PermissionClassification>;
  /**
   * Whether the repository of the workspace is trusted, so `plan` mode runs read-only `git`
   * commands, whose repository config could otherwise run code
   */
  trustRepository?: boolean;
  /**
   * A hook allowed the call: what only the mode or the tool's own approval setting would ask for
   * runs without asking, before the `auto` classifier and the `dontAsk` refusal. Deny and ask
   * rules, plan mode and the asks that guard a deny or ask rule (a command line or a list of files
   * the rules cannot check) still apply
   */
  allowedByHook?: boolean;
  /**
   * Whether path rules compare names without case and so match `SECRET.TXT` with `secret.txt`.
   * By default the file system of the workspace root is probed once (APFS and NTFS ignore case)
   */
  ignoreCase?: boolean;
}

/** A command line of a call with where and how it runs */
interface CommandCall {
  /** The command line as the call gives it */
  text: string;
  line: ParsedCommandLine;
  /** The directory it runs in, absolute */
  cwd: string;
  /** Whether every variable the call sets for it is a safe one */
  envSafe: boolean;
}

/** A call taken apart for matching, computed once per decision */
class CallSubject {
  private pathsPromise?: Promise<ResolvedPath[]>;
  private commandCall?: CommandCall | null;
  private shellFiles?: Promise<ShellFiles>;
  readonly parsed: unknown;
  /** The arguments as the tool gets them: read by its schema, defaults and transforms applied */
  readonly values: Record<string, unknown>;
  readonly kind: AccessKind | undefined;
  readonly schemaKeys: ReadonlySet<string>;

  constructor(
    readonly tool: Tool,
    readonly args: Record<string, unknown>,
    readonly base: string,
    readonly cwd: string,
    /** Whether path rules compare names without case, see `PermissionContext.ignoreCase` */
    readonly ignoreCase: boolean
  ) {
    const parsed =
      typeof tool.parameters.safeParse === 'function' ? tool.parameters.safeParse(args) : undefined;
    this.parsed = parsed?.success ? parsed.data : args;
    this.values = isPlainRecord(this.parsed) ? this.parsed : args;
    this.kind = accessKindOf(tool);
    this.schemaKeys = new Set([...Object.keys(args), ...shapeKeys(tool.parameters)]);
  }

  /** Whether the call touches everything under its paths, see `ToolAccess.subtree` */
  subtree(): boolean {
    if (this.kind !== 'read' && this.kind !== 'edit') return false;
    try {
      return this.tool.access?.subtree?.(this.parsed) === true;
    } catch {
      return true;
    }
  }

  rawPaths(): string[] {
    if (this.kind !== 'read' && this.kind !== 'edit') return [];
    if (this.tool.access?.paths) {
      try {
        return [...this.tool.access.paths(this.parsed)];
      } catch {
        return [];
      }
    }
    const value = this.values.path ?? this.values.file_path ?? this.values.filePath;
    if (typeof value === 'string') return [value];
    return this.kind === 'read' ? ['.'] : [];
  }

  paths(): Promise<ResolvedPath[]> {
    this.pathsPromise ??= Promise.all(
      this.rawPaths().map((path) => resolveCallPath(path, this.base))
    );
    return this.pathsPromise;
  }

  command(): CommandCall | undefined {
    if (this.commandCall !== undefined) return this.commandCall ?? undefined;
    this.commandCall = null;
    if (this.kind !== 'command') return undefined;
    const access = this.tool.access;
    let text: string | undefined;
    let cwd: string | undefined;
    let env: Readonly<Record<string, string>> | undefined;
    try {
      text = access?.command
        ? access.command(this.parsed)
        : typeof this.values.command === 'string'
          ? this.values.command
          : undefined;
      cwd = access?.cwd ? access.cwd(this.parsed) : stringOf(this.values.cwd);
      env = access?.env ? access.env(this.parsed) : recordOf(this.values.env);
    } catch {
      return undefined;
    }
    if (text === undefined) return undefined;
    this.commandCall = {
      text,
      line: parseCommandLine(text, env?.HOME !== undefined ? { home: env.HOME } : {}),
      cwd: cwd === undefined ? this.cwd : isAbsolute(cwd) ? resolve(cwd) : resolve(this.base, cwd),
      envSafe: Object.keys(env ?? {}).every(isSafeVariable),
    };
    return this.commandCall;
  }

  /** The files the command line reads and changes, best effort, for path rules */
  files(): Promise<ShellFiles> {
    this.shellFiles ??= (async () => {
      const files: ShellFiles = {
        reads: [],
        readsInto: [],
        writes: [],
        writesInto: [],
        overflow: false,
      };
      const call = this.command();
      if (!call) return files;
      const seen = new Set<string>();
      const resolveOnce = async (
        path: string,
        list: keyof Omit<ShellFiles, 'overflow'>,
        from: string
      ) => {
        const key = `${list}\u0000${from}\u0000${path}`;
        if (seen.has(key)) return;
        if (seen.size >= MAX_SHELL_PATHS) {
          files.overflow = true;
          return;
        }
        seen.add(key);
        files[list].push(await resolveCallPath(path, from));
      };
      for (const candidate of call.line.candidates) {
        const from = dirOf(call, candidate);
        if (from === undefined) continue;
        const named = filesOf(candidate);
        for (const path of named.reads) await resolveOnce(path, 'reads', from);
        for (const path of named.readsInto) await resolveOnce(path, 'readsInto', from);
        for (const path of named.writes) await resolveOnce(path, 'writes', from);
        for (const path of named.writesInto) await resolveOnce(path, 'writesInto', from);
      }
      return files;
    })();
    return this.shellFiles;
  }
}

/** The files a command line names, resolved, see {@link filesOf} */
interface ShellFiles {
  reads: ResolvedPath[];
  readsInto: ResolvedPath[];
  writes: ResolvedPath[];
  writesInto: ResolvedPath[];
  /** More paths than {@link MAX_SHELL_PATHS}: the rest were not checked */
  overflow: boolean;
}

/** Most distinct paths of a command line resolved for path rules */
const MAX_SHELL_PATHS = 2000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The directory `command` of a call runs in, undefined when a `cd` makes it unknown */
function dirOf(call: CommandCall, command: ShellCommand): string | undefined {
  return command.dir === undefined ? undefined : resolve(call.cwd, command.dir);
}

function isMove(command: ShellCommand): boolean {
  return ['cd', 'pushd', 'chdir'].includes(command.argv[0] ?? '');
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

/** The top-level fields of a Zod object schema, none for another schema */
function shapeKeys(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null || !('shape' in schema)) return [];
  const shape = schema.shape;
  return typeof shape === 'object' && shape !== null ? Object.keys(shape) : [];
}

function anchorsOf(rule: CompiledRule, subject: CallSubject, projectRoot: string) {
  return { cwd: rule.cwd ?? subject.cwd, source: rule.anchor ?? projectRoot };
}

/** Whether a path pattern rule matches one of `paths`, as named or with symlinks followed */
function anyPathMatches(
  rule: CompiledRule,
  specifier: string,
  paths: readonly ResolvedPath[],
  subject: CallSubject,
  projectRoot: string
): boolean {
  const pattern = compilePathPattern(
    specifier,
    rule.ref.behavior,
    anchorsOf(rule, subject, projectRoot)
  );
  if ('error' in pattern) {
    const tail = foldPath(`/${specifier.replace(/^\.?\//, '')}`, subject.ignoreCase);
    return paths.some(
      (path) =>
        foldPath(path.requested, subject.ignoreCase).endsWith(tail) ||
        foldPath(path.real, subject.ignoreCase).endsWith(tail)
    );
  }
  if (pattern.negated) return false;
  for (const path of paths) {
    for (const candidate of [path.requested, path.real]) {
      const how = pathMatches(pattern, candidate, subject.ignoreCase);
      if (how && !carvedOut(rule, pattern, how, candidate, subject, projectRoot)) return true;
    }
  }
  return false;
}

/** Whether a path rule covers something inside one of the directories a command reads through */
function reachesInto(
  rule: CompiledRule,
  specifier: string,
  dirs: readonly ResolvedPath[],
  subject: CallSubject,
  projectRoot: string
): boolean {
  const pattern = compilePathPattern(
    specifier,
    rule.ref.behavior,
    anchorsOf(rule, subject, projectRoot)
  );
  if ('error' in pattern || pattern.negated) return false;
  return dirs.some(
    (dir) =>
      patternReachesInto(pattern, dir.requested, subject.ignoreCase) ||
      patternReachesInto(pattern, dir.real, subject.ignoreCase)
  );
}

/** The host a URL names, lowercase, undefined for one that cannot be read */
function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether a `domain:...` specifier matches the URL of a fetch call: the host or a subdomain */
function domainMatches(subject: CallSubject, specifier: string): boolean | undefined {
  const colon = specifier.indexOf(':');
  if (colon === -1 || specifier.slice(0, colon).trim() !== 'domain') return undefined;
  const domain = specifier
    .slice(colon + 1)
    .trim()
    .toLowerCase();
  if (domain === '' || /\s/.test(domain)) return undefined;
  let url: unknown;
  try {
    url = subject.tool.access?.url ? subject.tool.access.url(subject.parsed) : subject.values.url;
  } catch {
    return false;
  }
  const host = hostOf(url);
  if (host === undefined) return false;
  if (domain.startsWith('*.')) return host.endsWith(domain.slice(1));
  return host === domain || host.endsWith(`.${domain}`);
}

/** Whether an `Agent(name)` specifier names the agent of an agent tool */
function agentMatches(subject: CallSubject, specifier: string): boolean {
  const name = specifier.trim();
  const agent = subject.tool.access?.agent;
  if (typeof agent !== 'function') return agent === name || subject.tool.name === name;
  try {
    return agent(subject.parsed) === name;
  } catch {
    return false;
  }
}

/** Whether `rule` (a `deny` or `ask` rule) covers the call */
async function restrictiveMatch(
  rule: CompiledRule,
  subject: CallSubject,
  projectRoot: string
): Promise<boolean> {
  const { tool } = subject;
  const specifier = rule.parsed.specifier;
  const pathFamily =
    rule.target.kind === 'family' &&
    (rule.target.family === 'read' || rule.target.family === 'edit') &&
    specifier !== undefined;
  if (pathFamily && subject.kind === 'command') {
    const files = await subject.files();
    const editing = rule.target.kind === 'family' && rule.target.family === 'edit';
    const paths = editing ? files.writes : [...files.reads, ...files.writes];
    if (anyPathMatches(rule, specifier, paths, subject, projectRoot)) return true;
    const into = editing ? files.writesInto : [...files.readsInto, ...files.writesInto];
    if (reachesInto(rule, specifier, into, subject, projectRoot)) return true;
  }
  const crossRead =
    rule.ref.behavior === 'deny' &&
    rule.target.kind === 'family' &&
    rule.target.family === 'read' &&
    specifier !== undefined &&
    subject.kind === 'edit';
  if (!crossRead && !targetCovers(rule.target, tool)) return false;
  if (specifier === undefined) return true;
  if (subject.kind === 'fetch') {
    const domain = domainMatches(subject, specifier);
    if (domain !== undefined) return domain;
  }
  if (subject.kind === 'agent') return agentMatches(subject, specifier);
  const parameter = parameterSpecifier(specifier, tool, subject.schemaKeys);
  if (parameter) return parameterMatches(own(subject.values, parameter.name), parameter.value);
  if (rule.target.kind === 'names' && rule.target.pathRulesNeverMatch) return false;
  if (subject.kind === 'command') {
    const call = subject.command();
    if (!call) return true;
    const spec = commandSpecifier(specifier);
    return call.line.candidates.some((command) => matchesCommandPattern(command.text, spec));
  }
  if (subject.kind === 'read' || subject.kind === 'edit') {
    const paths = await subject.paths();
    return (
      anyPathMatches(rule, specifier, paths, subject, projectRoot) ||
      (subject.subtree() && reachesInto(rule, specifier, paths, subject, projectRoot))
    );
  }
  return false;
}

/**
 * A command pattern read as the shell reads words, so `git "push" *` is `git push *` and
 * `cat ~/x` names the file in the home directory, as the command it matches is read
 */
function commandSpecifier(specifier: string): string {
  if (!/["'\\~]/.test(specifier)) return specifier;
  const trailing = specifier.trimEnd().endsWith(':*') ? ':*' : '';
  const body = trailing ? specifier.trimEnd().slice(0, -2) : specifier;
  const pieces = body.split('*').map((piece) => {
    const parsed = parseCommandLine(piece);
    const words = parsed.commands[0]?.argv ?? [];
    const lead = /^\s/.test(piece) ? ' ' : '';
    const tail = /\s$/.test(piece) ? ' ' : '';
    return words.length > 0 ? `${lead}${words.join(' ')}${tail}` : piece;
  });
  return `${pieces.join('*')}${trailing}`;
}

/** Whether a `!` pattern after `rule` in its list takes `path` out of it */
function carvedOut(
  rule: CompiledRule,
  pattern: PathPattern,
  how: 'self' | 'parent',
  path: string,
  subject: CallSubject,
  projectRoot: string
): boolean {
  if (!pattern.relative || how === 'parent') return false;
  for (const later of rule.list.slice(rule.index + 1)) {
    const specifier = later.parsed.specifier;
    if (!specifier?.trim().startsWith('!')) continue;
    if (later.parsed.tool !== rule.parsed.tool && !targetCovers(later.target, subject.tool))
      continue;
    const negation = compilePathPattern(
      specifier,
      rule.ref.behavior,
      anchorsOf(later, subject, projectRoot)
    );
    if (!('error' in negation) && pathMatches(negation, path, subject.ignoreCase)) return true;
  }
  return false;
}

/** What an allow decision may take for granted about the call */
interface AllowContext {
  /** Whether a deny or ask rule could name a command the line hides */
  guarded: boolean;
  /** Whether the call may write `path` without asking (redirections of an allowed command) */
  writable: (path: ResolvedPath) => Promise<boolean>;
  /** Whether a directory is inside the workspace */
  inside: (absolute: string) => Promise<boolean>;
}

/** Whether a command line of a call is plain enough for an allow: understood, safe env, inside */
async function allowableLine(call: CommandCall, allow: AllowContext): Promise<boolean> {
  if (!call.line.certain || call.line.commands.length === 0 || !call.envSafe) return false;
  if (!(await allow.inside(call.cwd))) return false;
  for (const command of call.line.commands) {
    if (!allowableCommand(command)) return false;
    const from = dirOf(call, command);
    if (from === undefined || !(await allow.inside(from))) return false;
    for (const redirect of command.redirects) {
      if (!redirect.writes || isDevice(redirect.target)) continue;
      if (!(await allow.writable(await resolveCallPath(redirect.target, from)))) return false;
    }
  }
  return true;
}

function isDevice(path: string): boolean {
  return ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(path);
}

/**
 * The allow rule that covers the call, when one does: for a command, every command of the line
 * must be understood and covered by an allow rule (not the same one), for a path every path, as
 * the call names it and with symlinks followed
 */
async function allowingRule(
  subject: CallSubject,
  rules: readonly CompiledRule[],
  projectRoot: string,
  allow: AllowContext
): Promise<CompiledRule | undefined> {
  const covering = rules.filter((rule) => targetCovers(rule.target, subject.tool));
  const bare = covering.find((rule) => rule.parsed.specifier === undefined);
  if (bare) {
    const call = subject.kind === 'command' ? subject.command() : undefined;
    if (!call || !allow.guarded || (await allowableLine(call, allow))) return bare;
  }
  const specific = covering.filter((rule) => {
    const specifier = rule.parsed.specifier;
    if (specifier === undefined) return false;
    if (rule.target.kind === 'names' && rule.target.pathRulesNeverMatch) return false;
    if (subject.kind === 'fetch' && domainMatches(subject, specifier) !== undefined) return true;
    return !parameterSpecifier(specifier, subject.tool, subject.schemaKeys);
  });
  if (specific.length === 0) return undefined;
  if (subject.kind === 'command') {
    const call = subject.command();
    if (!call || !(await allowableLine(call, allow))) return undefined;
    let first: CompiledRule | undefined;
    for (const command of call.line.commands) {
      if (isMove(command)) continue;
      const rule = specific.find((candidate) =>
        matchesCommandPattern(command.text, commandSpecifier(candidate.parsed.specifier ?? ''))
      );
      if (!rule) return undefined;
      first ??= rule;
    }
    return first;
  }
  if (subject.kind === 'fetch') {
    return specific.find((rule) => domainMatches(subject, rule.parsed.specifier ?? '') === true);
  }
  if (subject.kind === 'agent') {
    return specific.find((rule) => agentMatches(subject, rule.parsed.specifier ?? ''));
  }
  if (subject.kind === 'read' || subject.kind === 'edit') {
    const paths = await subject.paths();
    if (paths.length === 0) return undefined;
    let first: CompiledRule | undefined;
    for (const path of paths) {
      const rule = specific.find((candidate) => {
        const pattern = compilePathPattern(
          candidate.parsed.specifier ?? '',
          'allow',
          anchorsOf(candidate, subject, projectRoot)
        );
        if ('error' in pattern || pattern.negated) return false;
        return (
          pathMatches(pattern, path.requested, subject.ignoreCase) !== undefined &&
          pathMatches(pattern, path.real, subject.ignoreCase) !== undefined
        );
      });
      if (!rule) return undefined;
      first ??= rule;
    }
    return first;
  }
  return undefined;
}

function allowableCommand(command: ShellCommand): boolean {
  return command.understood && assignsOnlySafeVariables(command);
}

/** Whether a deny (and an ask) rule could name a command or a file a command line hides */
function guardsCommands(rules: PermissionRuleSet, tool: Tool, denyOnly = false): boolean {
  return [...rules.rules('deny'), ...(denyOnly ? [] : rules.rules('ask'))].some((rule) => {
    if (rule.parsed.specifier === undefined) return false;
    if (
      rule.target.kind === 'family' &&
      (rule.target.family === 'read' || rule.target.family === 'edit')
    ) {
      return true;
    }
    return targetCovers(rule.target, tool);
  });
}

/** Whether the call edits only inside the workspace (or the extra directories), for `acceptEdits` */
async function editsInside(
  subject: CallSubject,
  inside: (absolute: string) => Promise<boolean>
): Promise<boolean> {
  if (subject.kind === 'edit') {
    const paths = subject.rawPaths();
    if (paths.length === 0) return false;
    for (const path of paths) {
      if (!(await inside(isAbsolute(path) ? path : resolve(subject.base, path)))) return false;
    }
    return true;
  }
  if (subject.kind === 'command') {
    const call = subject.command();
    if (!call || !call.line.certain || call.line.commands.length === 0 || !call.envSafe)
      return false;
    if (!(await inside(call.cwd))) return false;
    for (const command of call.line.commands) {
      if (!allowableCommand(command)) return false;
      const from = dirOf(call, command);
      if (from === undefined || !(await inside(from))) return false;
      if (isMove(command)) continue;
      const paths = editCommandPaths(command);
      if (!paths || paths.length === 0) return false;
      const targets = [
        ...paths,
        ...command.redirects
          .filter((redirect) => redirect.writes || redirect.reads)
          .map((redirect) => redirect.target),
      ];
      for (const path of targets) {
        if (/[*?[$`~{]/.test(path) || isDevice(path)) {
          if (isDevice(path)) continue;
          return false;
        }
        if (!(await inside(isAbsolute(path) ? path : resolve(from, path)))) return false;
      }
    }
    return true;
  }
  return false;
}

/** Whether a bare rule names the command tool `tool`: `Bash`, `Bash(*)` or the tool's own name */
function commandRule(rule: CompiledRule, tool: Tool): boolean {
  return (
    (rule.target.kind === 'family' && rule.target.family === 'command') ||
    (rule.target.kind === 'name' && rule.target.name === tool.name)
  );
}

/** Whether a deleting tool (`file_delete`) removes a path outside the workspace */
async function deletesOutside(
  subject: CallSubject,
  inside: (absolute: string) => Promise<boolean>
): Promise<boolean> {
  if (subject.kind !== 'edit' || !DELETERS.has(subject.tool.name)) return false;
  for (const path of subject.rawPaths()) {
    if (!(await inside(isAbsolute(path) ? path : resolve(subject.base, path)))) return true;
  }
  return false;
}

/** Tools that delete the files they name for good */
const DELETERS = new Set(['file_delete']);

/** Whether `tool` only reads: the runtime's read-only tools, never what an MCP server claims */
function isReadOnly(tool: Tool, planTools: ReadonlySet<Tool> | undefined): boolean {
  if (planTools?.has(tool) === true) return true;
  if (accessKindOf(tool) === 'read') return true;
  return tool.mcp === undefined && tool.annotations?.readOnlyHint === true;
}

/** Whether a command call only reads, for `plan` mode */
function readOnlyCommandCall(subject: CallSubject, trustRepository: boolean): boolean {
  const call = subject.command();
  return (
    call !== undefined &&
    call.line.certain &&
    call.envSafe &&
    call.line.commands.length > 0 &&
    call.line.commands.every((command) => isReadOnlyCommand(command, { trustRepository }))
  );
}

function ruleReason(ref: PermissionRuleRef, verb: string): string {
  const source = ref.origin ? `${ref.layer}, ${ref.origin}` : ref.layer;
  return `${verb} by the rule ${ref.rule} (${source})`;
}

/** Whether path rules of a decision compare names without case, see `PermissionContext.ignoreCase` */
function ignoresCase(
  context: Pick<PermissionContext, 'ignoreCase'>,
  base: string
): Promise<boolean> {
  return context.ignoreCase === undefined
    ? pathsIgnoreCase(base)
    : Promise.resolve(context.ignoreCase);
}

/** The working directory and the base of relative call paths, from the context */
function placesOf(context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>): {
  base: string;
  cwd: string;
  projectRoot: string;
} {
  const workspace = context.workspace;
  const fallback = resolve(context.cwd ?? process.cwd());
  const base = workspace ? workspace.root : fallback;
  const cwd = workspace ? resolve(workspace.root, workspace.cwd) : fallback;
  return { base, cwd, projectRoot: resolve(context.projectRoot ?? cwd) };
}

/** Whether `absolute` lies inside the workspace (else the working directory) or an extra directory */
function insideOf(
  context: PermissionContext,
  cwd: string,
  extra: readonly string[]
): (absolute: string) => Promise<boolean> {
  return async (absolute) => {
    if (context.workspace && (await context.workspace.contains(absolute))) return true;
    const roots = [...(context.workspace ? [] : [cwd]), ...extra];
    return roots.length > 0 && isPathAllowed(absolute, roots);
  };
}

/**
 * Decides a call of `tool` with `args`: `deny`, `ask` or `allow`, with why and the rule that
 * decided. In order: a `deny` rule of any layer refuses, `plan` mode refuses what is not
 * read-only, an `ask` rule asks (`bypassPermissions` runs it), an `allow` rule runs it,
 * `bypassPermissions` and `acceptEdits` (for edits inside the workspace) run it, a read-only
 * command runs in `plan` mode, an edit or a call whose tool needs approval asks (`auto` mode lets
 * its classifier decide), and any other call runs. `dontAsk` mode refuses what would ask. A command
 * line an allow rule cannot fully read never runs by a rule, and in `bypassPermissions` mode it asks
 * when a deny or ask rule could name what it hides
 */
export async function resolvePermission(
  tool: Tool,
  args: Record<string, unknown>,
  context: PermissionContext
): Promise<PermissionDecision> {
  const decided = await decide(tool, args, context);
  if (context.mode !== 'dontAsk' || decided.decision !== 'ask') return decided;
  return {
    ...decided,
    decision: 'deny',
    decidedBy: decided.decidedBy === 'rule' ? 'rule' : 'mode',
    reason: `dontAsk mode refuses what would ask: ${decided.reason}`,
  };
}

async function decide(
  tool: Tool,
  args: Record<string, unknown>,
  context: PermissionContext
): Promise<PermissionDecision> {
  const { mode, rules } = context;
  const { base, cwd, projectRoot } = placesOf(context);
  const subject = new CallSubject(tool, args, base, cwd, await ignoresCase(context, base));
  const decision = (
    verdict: PermissionBehavior,
    decidedBy: PermissionDecision['decidedBy'],
    reason: string,
    rule?: PermissionRuleRef
  ): PermissionDecision => ({ decision: verdict, reason, decidedBy, mode, ...(rule && { rule }) });
  const inside = insideOf(context, cwd, rules.additionalDirectories);
  const guarded = subject.kind === 'command' && guardsCommands(rules, tool);
  const allow: AllowContext = {
    guarded,
    inside,
    writable: async (path) =>
      (mode === 'acceptEdits' || mode === 'bypassPermissions') &&
      (await inside(path.requested)) &&
      (await inside(path.real)),
  };

  for (const rule of rules.rules('deny')) {
    if (await restrictiveMatch(rule, subject, projectRoot)) {
      return decision('deny', 'rule', ruleReason(rule.ref, 'Denied'), rule.ref);
    }
  }
  if (guarded && (await subject.files()).overflow) {
    return decision(
      mode === 'bypassPermissions' ? 'deny' : 'ask',
      'mode',
      'The command line names more files than the rules can check'
    );
  }
  const readOnlyCommand =
    subject.kind === 'command' && readOnlyCommandCall(subject, context.trustRepository === true);
  if (mode === 'plan' && !isReadOnly(tool, context.planTools) && !readOnlyCommand) {
    return decision(
      'deny',
      'mode',
      `The run is in plan mode: only read-only tools and commands run until the plan is approved (present it with exit_plan_mode)`
    );
  }
  const commandCall = subject.kind === 'command' ? subject.command() : undefined;
  const runsIn = commandCall ? commandWorkspace(tool, context.workspace) : undefined;
  const sandboxed = commandCall
    ? await sandboxedCall(runsIn, commandCall.text, subject.values)
    : undefined;
  const inSandbox = sandboxed?.route.sandboxed === true;
  const removalChecks = context.removalChecks !== false;
  if (commandCall && removalChecks) {
    const critical = criticalRemoval(commandCall.line, commandCall.cwd, runsIn?.root ?? base, {
      ignoreCase: subject.ignoreCase,
    });
    if (critical !== undefined) {
      return decision(
        'ask',
        'mode',
        `The command removes ${critical}, a critical path (the workspace root or a directory above it, the home directory, / or a .git directory) or one the shell decides, which always asks`
      );
    }
  }
  const hidden = commandCall !== undefined && guarded && !(await allowableLine(commandCall, allow));
  const autoAllow =
    sandboxed !== undefined &&
    inSandbox &&
    sandboxed.sandbox.autoAllow &&
    mode !== 'plan' &&
    !sandboxed.domains &&
    !hidden &&
    context.guardrailsApproval !== true &&
    commandCall !== undefined &&
    plainForSandbox(commandCall.line);
  for (const rule of rules.rules('ask')) {
    if (!(await restrictiveMatch(rule, subject, projectRoot))) continue;
    if (mode === 'bypassPermissions') break;
    if (autoAllow && rule.parsed.specifier === undefined && commandRule(rule, tool)) continue;
    return decision('ask', 'rule', ruleReason(rule.ref, 'Asked'), rule.ref);
  }
  if (mode !== 'bypassPermissions' && !inSandbox && removalChecks) {
    const outside = commandCall
      ? await removesOutside(commandCall.line, commandCall.cwd, inside)
      : await deletesOutside(subject, inside);
    if (outside) {
      return decision(
        'ask',
        'mode',
        'The call removes files outside the workspace, and no sandbox confines it, which always asks'
      );
    }
  }
  const allowing =
    inSandbox && sandboxed.domains
      ? undefined
      : await allowingRule(subject, rules.rules('allow'), projectRoot, allow);
  if (allowing) return decision('allow', 'rule', ruleReason(allowing.ref, 'Allowed'), allowing.ref);
  if (autoAllow) {
    return decision(
      'allow',
      'sandbox',
      `The command runs in the workspace's OS sandbox (${sandboxed.sandbox.kind}), which allows it without asking`
    );
  }
  if (mode === 'bypassPermissions') {
    if (hidden && guardsCommands(rules, tool, true)) {
      return decision(
        'deny',
        'mode',
        'The command line is not plain enough to tell whether it runs a command or reads a file a deny rule names, and bypassPermissions mode never asks'
      );
    }
    return decision('allow', 'mode', 'bypassPermissions mode runs every call no deny rule refuses');
  }
  if (
    mode === 'acceptEdits' &&
    (subject.kind === 'edit' || subject.kind === 'command') &&
    (await editsInside(subject, inside))
  ) {
    return decision('allow', 'mode', 'acceptEdits mode runs edits inside the workspace');
  }
  if (mode === 'plan' && readOnlyCommand) {
    return decision('allow', 'mode', 'plan mode runs read-only commands');
  }
  const editAsks = subject.kind === 'edit' || hidden;
  const namesHosts = inSandbox && sandboxed.domains;
  if (!context.needsApproval && !editAsks && !namesHosts) {
    return decision('allow', 'default', `${tool.name} needs no approval`);
  }
  if (context.allowedByHook && !hidden) {
    return decision('allow', 'hook', 'Allowed by a hook');
  }
  const reason = hidden
    ? 'The command line is not plain enough to tell whether it runs a command or reads a file a deny or ask rule names'
    : namesHosts
      ? 'The command names hosts of its own to reach through the sandbox'
      : editAsks && !context.needsApproval
        ? `${tool.name} edits files, which asks unless a rule allows it or the mode is acceptEdits`
        : `${tool.name} needs approval for this call`;
  if (mode === 'auto' && context.classify && !hidden) {
    try {
      const classified = await context.classify(reason);
      return decision(classified.decision, 'classifier', classified.reason);
    } catch (error) {
      return decision(
        'ask',
        'tool',
        `The auto mode classifier failed (${error instanceof Error ? error.message : String(error)}), so the call asks`
      );
    }
  }
  return decision('ask', 'tool', reason);
}

/** What allow checks need when no run decides: the call's workspace only */
function looseAllow(
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>
): AllowContext {
  const { cwd } = placesOf(context);
  const inside = insideOf(
    { mode: 'default', rules: new PermissionRuleSet([]), needsApproval: false, ...context },
    cwd,
    []
  );
  return { guarded: false, inside, writable: async () => false };
}

/**
 * Whether `rule` would allow this call of `tool`, for an "always allow" answer: a rule that does
 * not cover the call it answers is not saved
 */
export async function ruleAllowsCall(
  rule: string,
  tool: Tool,
  args: Record<string, unknown>,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot' | 'ignoreCase'>,
  anchor?: string
): Promise<boolean> {
  const rules = new PermissionRuleSet([
    { layer: 'session', allow: [rule], ...(anchor !== undefined && { anchor }) },
  ]);
  if (rules.warnings.length > 0) return false;
  const { base, cwd, projectRoot } = placesOf(context);
  return (
    (await allowingRule(
      new CallSubject(tool, args, base, cwd, await ignoresCase(context, base)),
      rules.rules('allow'),
      projectRoot,
      looseAllow(context)
    )) !== undefined
  );
}

/**
 * Whether `rule` names this call of `tool` the way a `deny` or `ask` rule would: any command of a
 * command line, any path a call touches. For the `if` of a hook, which runs when it matches.
 * A rule that cannot be read gives its error
 */
export async function ruleMatchesCall(
  rule: string,
  tool: Tool,
  args: Record<string, unknown>,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot' | 'ignoreCase'>,
  anchor?: string
): Promise<boolean | { error: string }> {
  const rules = new PermissionRuleSet([
    { layer: 'session', ask: [rule], ...(anchor !== undefined && { anchor }) },
  ]);
  const [compiled] = rules.rules('ask');
  if (!compiled) return { error: rules.warnings[0] ?? `"${rule}" is not a rule` };
  const { base, cwd, projectRoot } = placesOf(context);
  return restrictiveMatch(
    compiled,
    new CallSubject(tool, args, base, cwd, await ignoresCase(context, base)),
    projectRoot
  );
}

const PATH_SPECIALS = /[*?[\]!#\\()]/g;
const COMMAND_SPECIALS = /[*"'\\()]/;

/**
 * The rules an "always allow" answer to this call may save, narrowest last: the default
 * suggestion, `run_command(npm test *)` for a command (its program and subcommand, the command as
 * the parser understood it, wrappers off), `edit_file(./src/app.ts)` for a path inside the working
 * directory (`//...` outside it), the tool name for any other call, and the exact command. None
 * for a command line the parser does not fully understand or of several commands
 */
export function rememberableRules(
  tool: Tool,
  args: Record<string, unknown>,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>
): string[] {
  const { base, cwd } = placesOf(context);
  const subject = new CallSubject(tool, args, base, cwd, false);
  if (subject.kind === 'command') {
    const call = subject.command();
    if (!call || !call.line.certain || call.line.commands.length !== 1 || !call.envSafe) return [];
    const command = call.line.commands[0];
    const words = command.argv;
    if (
      words.length === 0 ||
      !allowableCommand(command) ||
      command.redirects.some((redirect) => redirect.writes) ||
      words.some((word) => COMMAND_SPECIALS.test(word) || /\s/.test(word))
    ) {
      return [];
    }
    const program = words[0];
    const prefix =
      words[1] !== undefined && /^[A-Za-z0-9][\w.:-]*$/.test(words[1]) && !program.includes('/')
        ? `${program} ${words[1]}`
        : basename(program) === program
          ? program
          : undefined;
    const exact = `${tool.name}(${words.join(' ')})`;
    return prefix ? [`${tool.name}(${prefix} *)`, exact] : [exact];
  }
  if (subject.kind === 'read' || subject.kind === 'edit') {
    const paths = subject.rawPaths();
    if (paths.length !== 1) return [];
    const absolute = normalizeRulePath(
      isAbsolute(paths[0]) ? resolve(paths[0]) : resolve(base, paths[0])
    );
    const from = normalizeRulePath(cwd);
    const inside = relative(from, absolute);
    const spec =
      inside !== '' && !inside.startsWith('..') && !posix.isAbsolute(inside)
        ? `./${inside.split('\\').join('/')}`
        : `/${absolute}`;
    return [`${tool.name}(${spec.replace(PATH_SPECIALS, (char) => `\\${char}`)})`];
  }
  return [tool.name];
}

/** The allow rule an "always allow" answer to this call saves by default, see {@link rememberableRules} */
export function suggestRule(
  tool: Tool,
  args: Record<string, unknown>,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>
): string | undefined {
  return rememberableRules(tool, args, context)[0];
}

let readProbe: Tool | undefined;

/**
 * Whether no `Read(...)` deny or ask rule of `rules` covers `path` (relative to the workspace
 * root or absolute), for tools that read or list many files: they leave out what a rule refuses,
 * and what one asks for too, since a search reads it without anyone asked. A bare `Read` ask
 * makes the search itself ask, so it withholds nothing here
 */
export async function readAllowed(
  path: string,
  rules: PermissionRuleSet,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot' | 'ignoreCase'>
): Promise<boolean> {
  readProbe ??= {
    name: 'read_file',
    description: 'A read of one file',
    parameters: z.object({ path: z.string() }),
    access: { kind: 'read', paths: () => [] },
    execute: async () => null,
    toJSON: () => ({
      name: 'read_file',
      description: '',
      parameters: { type: 'object', properties: {} },
    }),
  };
  const { base, cwd, projectRoot } = placesOf(context);
  const subject = new CallSubject(readProbe, { path }, base, cwd, await ignoresCase(context, base));
  const resolved = [await resolveCallPath(path, base)];
  for (const behavior of ['deny', 'ask'] as const) {
    for (const rule of rules.rules(behavior)) {
      if (rule.target.kind !== 'family' || rule.target.family !== 'read') continue;
      if (rule.parsed.specifier === undefined) {
        if (behavior === 'deny') return false;
        continue;
      }
      if (anyPathMatches(rule, rule.parsed.specifier, resolved, subject, projectRoot)) return false;
    }
  }
  return true;
}
