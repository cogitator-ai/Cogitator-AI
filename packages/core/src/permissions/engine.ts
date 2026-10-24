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
  pathMatches,
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

const BEHAVIORS: readonly PermissionBehavior[] = ['deny', 'ask', 'allow'];

/** A rule of a layer, read and ready to match */
interface CompiledRule {
  ref: PermissionRuleRef;
  parsed: ParsedRule;
  target: RuleTarget;
  /** Where its `/path` patterns start from */
  anchor?: string;
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
}

/** A command line of a call with where and how it runs */
interface CommandCall {
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
  private shellFiles?: Promise<{ reads: ResolvedPath[]; writes: ResolvedPath[] }>;
  readonly parsed: unknown;
  readonly kind: AccessKind | undefined;
  readonly schemaKeys: ReadonlySet<string>;

  constructor(
    readonly tool: Tool,
    readonly args: Record<string, unknown>,
    readonly base: string,
    readonly cwd: string
  ) {
    const parsed =
      typeof tool.parameters.safeParse === 'function' ? tool.parameters.safeParse(args) : undefined;
    this.parsed = parsed?.success ? parsed.data : args;
    this.kind = accessKindOf(tool);
    this.schemaKeys = new Set([...Object.keys(args), ...shapeKeys(tool.parameters)]);
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
    const value = this.args.path ?? this.args.file_path ?? this.args.filePath;
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
        : typeof this.args.command === 'string'
          ? this.args.command
          : undefined;
      cwd = access?.cwd ? access.cwd(this.parsed) : stringOf(this.args.cwd);
      env = access?.env ? access.env(this.parsed) : recordOf(this.args.env);
    } catch {
      return undefined;
    }
    if (text === undefined) return undefined;
    this.commandCall = {
      line: parseCommandLine(text),
      cwd: cwd === undefined ? this.cwd : isAbsolute(cwd) ? resolve(cwd) : resolve(this.base, cwd),
      envSafe: Object.keys(env ?? {}).every(isSafeVariable),
    };
    return this.commandCall;
  }

  /** The files the command line reads and changes, best effort, for path rules */
  files(): Promise<{ reads: ResolvedPath[]; writes: ResolvedPath[] }> {
    this.shellFiles ??= (async () => {
      const call = this.command();
      if (!call) return { reads: [], writes: [] };
      const reads: ResolvedPath[] = [];
      const writes: ResolvedPath[] = [];
      for (const candidate of call.line.candidates) {
        const files = filesOf(candidate);
        for (const path of files.reads) reads.push(await resolveCallPath(path, call.cwd));
        for (const path of files.writes) writes.push(await resolveCallPath(path, call.cwd));
      }
      return { reads, writes };
    })();
    return this.shellFiles;
  }
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
  return { cwd: subject.cwd, source: rule.anchor ?? projectRoot };
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
    return paths.some(
      (path) =>
        path.requested.endsWith(`/${specifier.replace(/^\.?\//, '')}`) ||
        path.real.endsWith(`/${specifier.replace(/^\.?\//, '')}`)
    );
  }
  if (pattern.negated) return false;
  for (const path of paths) {
    for (const candidate of [path.requested, path.real]) {
      const how = pathMatches(pattern, candidate);
      if (how && !carvedOut(rule, pattern, how, candidate, subject, projectRoot)) return true;
    }
  }
  return false;
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
  const match = /^\s*domain\s*:\s*(\S+)\s*$/.exec(specifier);
  if (!match) return undefined;
  const domain = match[1].toLowerCase();
  let url: unknown;
  try {
    url = subject.tool.access?.url ? subject.tool.access.url(subject.parsed) : subject.args.url;
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
  return subject.tool.access?.agent === name || subject.tool.name === name;
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
    const paths =
      rule.target.kind === 'family' && rule.target.family === 'edit'
        ? files.writes
        : [...files.reads, ...files.writes];
    if (anyPathMatches(rule, specifier, paths, subject, projectRoot)) return true;
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
  if (parameter) return parameterMatches(subject.args[parameter.name], parameter.value);
  if (rule.target.kind === 'names' && rule.target.pathRulesNeverMatch) return false;
  if (subject.kind === 'command') {
    const call = subject.command();
    if (!call) return true;
    const spec = commandSpecifier(specifier);
    return call.line.candidates.some((command) => matchesCommandPattern(command.text, spec));
  }
  if (subject.kind === 'read' || subject.kind === 'edit') {
    return anyPathMatches(rule, specifier, await subject.paths(), subject, projectRoot);
  }
  return false;
}

/** A command pattern read as the shell reads words, so `git "push" *` is `git push *` */
function commandSpecifier(specifier: string): string {
  if (!/["'\\]/.test(specifier)) return specifier;
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
    if (!('error' in negation) && pathMatches(negation, path)) return true;
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
    for (const redirect of command.redirects) {
      if (!redirect.writes || isDevice(redirect.target)) continue;
      if (!(await allow.writable(await resolveCallPath(redirect.target, call.cwd)))) return false;
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
          pathMatches(pattern, path.requested) !== undefined &&
          pathMatches(pattern, path.real) !== undefined
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

/** Whether a deny or ask rule could name a command or a file a command line hides */
function guardsCommands(rules: PermissionRuleSet, tool: Tool): boolean {
  return [...rules.rules('deny'), ...rules.rules('ask')].some((rule) => {
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
        if (!(await inside(isAbsolute(path) ? path : resolve(call.cwd, path)))) return false;
      }
    }
    return true;
  }
  return false;
}

/** Whether `tool` only reads: the runtime's read-only tools, never what an MCP server claims */
function isReadOnly(tool: Tool, planTools: ReadonlySet<Tool> | undefined): boolean {
  if (planTools?.has(tool) === true) return true;
  if (accessKindOf(tool) === 'read') return true;
  return tool.mcp === undefined && tool.annotations?.readOnlyHint === true;
}

/** Whether a command call only reads, for `plan` mode */
function readOnlyCommandCall(subject: CallSubject): boolean {
  const call = subject.command();
  return (
    call !== undefined &&
    call.line.certain &&
    call.envSafe &&
    call.line.commands.length > 0 &&
    call.line.commands.every(isReadOnlyCommand)
  );
}

function ruleReason(ref: PermissionRuleRef, verb: string): string {
  const source = ref.origin ? `${ref.layer}, ${ref.origin}` : ref.layer;
  return `${verb} by the rule ${ref.rule} (${source})`;
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
  const subject = new CallSubject(tool, args, base, cwd);
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
  const readOnlyCommand = subject.kind === 'command' && readOnlyCommandCall(subject);
  if (mode === 'plan' && !isReadOnly(tool, context.planTools) && !readOnlyCommand) {
    return decision(
      'deny',
      'mode',
      `The run is in plan mode: only read-only tools and commands run until the plan is approved (present it with exit_plan_mode)`
    );
  }
  for (const rule of rules.rules('ask')) {
    if (!(await restrictiveMatch(rule, subject, projectRoot))) continue;
    if (mode === 'bypassPermissions') break;
    return decision('ask', 'rule', ruleReason(rule.ref, 'Asked'), rule.ref);
  }
  const allowing = await allowingRule(subject, rules.rules('allow'), projectRoot, allow);
  if (allowing) return decision('allow', 'rule', ruleReason(allowing.ref, 'Allowed'), allowing.ref);
  if (mode === 'bypassPermissions') {
    const call = subject.kind === 'command' ? subject.command() : undefined;
    if (call && guarded && !(await allowableLine(call, allow))) {
      return decision(
        'ask',
        'mode',
        'The command line may hide a command or a file a deny or ask rule names, so it asks even in bypassPermissions mode'
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
  const editAsks = subject.kind === 'edit';
  if (!context.needsApproval && !editAsks) {
    return decision('allow', 'default', `${tool.name} needs no approval`);
  }
  const reason =
    editAsks && !context.needsApproval
      ? `${tool.name} edits files, which asks unless a rule allows it or the mode is acceptEdits`
      : `${tool.name} needs approval for this call`;
  if (mode === 'auto' && context.classify) {
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
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>,
  anchor?: string
): Promise<boolean> {
  const rules = new PermissionRuleSet([
    { layer: 'session', allow: [rule], ...(anchor !== undefined && { anchor }) },
  ]);
  if (rules.warnings.length > 0) return false;
  const { base, cwd, projectRoot } = placesOf(context);
  return (
    (await allowingRule(
      new CallSubject(tool, args, base, cwd),
      rules.rules('allow'),
      projectRoot,
      looseAllow(context)
    )) !== undefined
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
  const subject = new CallSubject(tool, args, base, cwd);
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
 * Whether no `Read(...)` deny rule of `rules` covers `path` (relative to the workspace root or
 * absolute), for tools that read or list many files
 */
export async function readAllowed(
  path: string,
  rules: PermissionRuleSet,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>
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
  const subject = new CallSubject(readProbe, { path }, base, cwd);
  for (const rule of rules.rules('deny')) {
    if (rule.target.kind !== 'family' || rule.target.family !== 'read') continue;
    if (rule.parsed.specifier === undefined) return false;
    if (
      anyPathMatches(
        rule,
        rule.parsed.specifier,
        [await resolveCallPath(path, base)],
        subject,
        projectRoot
      )
    ) {
      return false;
    }
  }
  return true;
}
