/**
 * `resolvePermission`: the one place a tool call is allowed, asked about or refused, by the rules
 * of every layer and the run's mode
 */

import { isAbsolute, posix, relative, resolve } from 'node:path';
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
  parameterMatches,
  parameterSpecifier,
  parseRule,
  ruleTarget,
  targetCovers,
  type ParsedRule,
  type RuleTarget,
} from './rules';
import {
  assignsOnlySafeVariables,
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
  /** Tools `plan` mode runs although they are not read-only, such as `exit_plan_mode` */
  planTools?: ReadonlySet<string>;
  /** Decides a call that would ask in `auto` mode */
  classify?: (reason: string) => Promise<PermissionClassification>;
}

/** A call taken apart for matching, computed once per decision */
class CallSubject {
  private pathsPromise?: Promise<ResolvedPath[]>;
  private commandLine?: ParsedCommandLine | null;
  readonly parsed: unknown;
  readonly kind: 'read' | 'edit' | 'command' | undefined;
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

  command(): ParsedCommandLine | undefined {
    if (this.commandLine !== undefined) return this.commandLine ?? undefined;
    let text: string | undefined;
    if (this.kind === 'command') {
      if (this.tool.access?.command) {
        try {
          text = this.tool.access.command(this.parsed);
        } catch {
          text = undefined;
        }
      } else if (typeof this.args.command === 'string') {
        text = this.args.command;
      }
    }
    this.commandLine = text === undefined ? null : parseCommandLine(text);
    return this.commandLine ?? undefined;
  }
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

/** Whether `rule` (a `deny` or `ask` rule) covers the call */
async function restrictiveMatch(
  rule: CompiledRule,
  subject: CallSubject,
  projectRoot: string
): Promise<boolean> {
  const { tool } = subject;
  const crossRead =
    rule.ref.behavior === 'deny' &&
    rule.target.kind === 'family' &&
    rule.target.family === 'read' &&
    rule.parsed.specifier !== undefined &&
    subject.kind === 'edit';
  if (!crossRead && !targetCovers(rule.target, tool)) return false;
  const specifier = rule.parsed.specifier;
  if (specifier === undefined) return true;
  const parameter = parameterSpecifier(specifier, tool, subject.schemaKeys);
  if (parameter) return parameterMatches(subject.args[parameter.name], parameter.value);
  if (rule.target.kind === 'names' && rule.target.pathRulesNeverMatch) return false;
  if (subject.kind === 'command') {
    const line = subject.command();
    if (!line) return false;
    return [...line.commands, ...line.nested].some((command) =>
      matchesCommandPattern(command.text, specifier)
    );
  }
  if (subject.kind === 'read' || subject.kind === 'edit') {
    const pattern = compilePathPattern(
      specifier,
      rule.ref.behavior,
      anchorsOf(rule, subject, projectRoot)
    );
    if ('error' in pattern || pattern.negated) return false;
    for (const path of await subject.paths()) {
      for (const candidate of [path.requested, path.real]) {
        const how = pathMatches(pattern, candidate);
        if (how && !carvedOut(rule, pattern, how, candidate, subject, projectRoot)) return true;
      }
    }
  }
  return false;
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

/**
 * The allow rule that covers the call, when one does: for a command, every command of the line
 * must be covered by an allow rule (not the same one), for a path every path, as the call names
 * it and with symlinks followed
 */
async function allowingRule(
  subject: CallSubject,
  rules: readonly CompiledRule[],
  projectRoot: string
): Promise<CompiledRule | undefined> {
  const covering = rules.filter((rule) => targetCovers(rule.target, subject.tool));
  const bare = covering.find((rule) => rule.parsed.specifier === undefined);
  if (bare) return bare;
  const specific = covering.filter((rule) => {
    const specifier = rule.parsed.specifier;
    if (specifier === undefined) return false;
    if (rule.target.kind === 'names' && rule.target.pathRulesNeverMatch) return false;
    return !parameterSpecifier(specifier, subject.tool, subject.schemaKeys);
  });
  if (specific.length === 0) return undefined;
  if (subject.kind === 'command') {
    const line = subject.command();
    if (!line || !line.certain || line.commands.length === 0) return undefined;
    let first: CompiledRule | undefined;
    for (const command of line.commands) {
      if (!allowableCommand(command)) return undefined;
      const rule = specific.find((candidate) =>
        matchesCommandPattern(command.text, candidate.parsed.specifier ?? '')
      );
      if (!rule) return undefined;
      first ??= rule;
    }
    return first;
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
  return !command.redirectsOutput && assignsOnlySafeVariables(command);
}

const WORKSPACE_EDIT_COMMANDS = new Set(['mkdir', 'touch', 'mv', 'cp']);

/** Whether the call edits only inside the workspace (or the extra directories), for `acceptEdits` */
async function editsInside(
  subject: CallSubject,
  context: PermissionContext,
  extra: readonly string[]
): Promise<boolean> {
  const inside = async (absolute: string): Promise<boolean> => {
    if (context.workspace && (await context.workspace.contains(absolute))) return true;
    const roots = [...(context.workspace ? [] : [subject.cwd]), ...extra];
    return roots.length > 0 && isPathAllowed(absolute, roots);
  };
  if (subject.kind === 'edit') {
    const paths = subject.rawPaths();
    if (paths.length === 0) return false;
    for (const path of paths) {
      if (!(await inside(isAbsolute(path) ? path : resolve(subject.base, path)))) return false;
    }
    return true;
  }
  if (subject.kind === 'command') {
    const line = subject.command();
    if (!line || !line.certain || line.commands.length === 0) return false;
    for (const command of line.commands) {
      if (!WORKSPACE_EDIT_COMMANDS.has(command.words[0] ?? '') || !allowableCommand(command)) {
        return false;
      }
      const operands = command.words.slice(1).filter((word) => !word.startsWith('-'));
      if (operands.length === 0) return false;
      for (const operand of operands) {
        if (/[*?$`~{]/.test(operand)) return false;
        if (!(await inside(isAbsolute(operand) ? operand : resolve(subject.cwd, operand)))) {
          return false;
        }
      }
    }
    return true;
  }
  return false;
}

function isReadOnly(tool: Tool, planTools: ReadonlySet<string> | undefined): boolean {
  return (
    tool.annotations?.readOnlyHint === true ||
    accessKindOf(tool) === 'read' ||
    planTools?.has(tool.name) === true
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

/**
 * Decides a call of `tool` with `args`: `deny`, `ask` or `allow`, with why and the rule that
 * decided. In order: a `deny` rule of any layer refuses, `plan` mode refuses what is not
 * read-only, an `ask` rule asks (`bypassPermissions` runs it), an `allow` rule runs it,
 * `bypassPermissions` and `acceptEdits` (for edits inside the workspace) run it, a call whose
 * tool needs approval asks (`auto` mode lets its classifier decide), and any other call runs
 */
export async function resolvePermission(
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

  for (const rule of rules.rules('deny')) {
    if (await restrictiveMatch(rule, subject, projectRoot)) {
      return decision('deny', 'rule', ruleReason(rule.ref, 'Denied'), rule.ref);
    }
  }
  if (mode === 'plan' && !isReadOnly(tool, context.planTools)) {
    return decision(
      'deny',
      'mode',
      `The run is in plan mode: only read-only tools run until the plan is approved (present it with exit_plan_mode)`
    );
  }
  for (const rule of rules.rules('ask')) {
    if (!(await restrictiveMatch(rule, subject, projectRoot))) continue;
    if (mode === 'bypassPermissions') {
      return decision(
        'allow',
        'mode',
        'bypassPermissions mode runs every call no deny rule refuses'
      );
    }
    return decision('ask', 'rule', ruleReason(rule.ref, 'Asked'), rule.ref);
  }
  const allowing = await allowingRule(subject, rules.rules('allow'), projectRoot);
  if (allowing) return decision('allow', 'rule', ruleReason(allowing.ref, 'Allowed'), allowing.ref);
  if (mode === 'bypassPermissions') {
    return decision('allow', 'mode', 'bypassPermissions mode runs every call no deny rule refuses');
  }
  if (
    mode === 'acceptEdits' &&
    (subject.kind === 'edit' || subject.kind === 'command') &&
    (await editsInside(subject, context, rules.additionalDirectories))
  ) {
    return decision('allow', 'mode', 'acceptEdits mode runs edits inside the workspace');
  }
  if (!context.needsApproval) return decision('allow', 'default', `${tool.name} needs no approval`);
  const reason = `${tool.name} needs approval for this call`;
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
      projectRoot
    )) !== undefined
  );
}

const PATH_SPECIALS = /[*?[\]!#\\()]/g;

/**
 * The allow rule an "always allow" answer to this call saves by default, in the tool's own name:
 * `run_command(npm test *)` for a command (its program and subcommand), `edit_file(./src/app.ts)`
 * for a path inside the working directory (`//...` outside it), the tool name for any other call.
 * Undefined for a command line of several commands, which no one rule allows
 */
export function suggestRule(
  tool: Tool,
  args: Record<string, unknown>,
  context: Pick<PermissionContext, 'workspace' | 'cwd' | 'projectRoot'>
): string | undefined {
  const { base, cwd } = placesOf(context);
  const subject = new CallSubject(tool, args, base, cwd);
  if (subject.kind === 'command') {
    const line = subject.command();
    if (!line || !line.certain || line.commands.length !== 1 || line.nested.length > 0) {
      return undefined;
    }
    const words = line.commands[0].words;
    if (words.length === 0 || words.some((word) => /[()]/.test(word))) return undefined;
    const prefix =
      words[1] !== undefined && /^[A-Za-z0-9][\w.:-]*$/.test(words[1])
        ? `${words[0]} ${words[1]}`
        : words[0];
    return `${tool.name}(${prefix} *)`;
  }
  if (subject.kind === 'read' || subject.kind === 'edit') {
    const paths = subject.rawPaths();
    if (paths.length !== 1) return undefined;
    const absolute = normalizeRulePath(
      isAbsolute(paths[0]) ? resolve(paths[0]) : resolve(base, paths[0])
    );
    const from = normalizeRulePath(cwd);
    const inside = relative(from, absolute);
    const spec =
      inside !== '' && !inside.startsWith('..') && !posix.isAbsolute(inside)
        ? `./${inside.split('\\').join('/')}`
        : `/${absolute}`;
    return `${tool.name}(${spec.replace(PATH_SPECIALS, (char) => `\\${char}`)})`;
  }
  return tool.name;
}
