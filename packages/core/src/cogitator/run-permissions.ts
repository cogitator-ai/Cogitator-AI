import { resolve } from 'node:path';
import {
  CogitatorError,
  ErrorCode,
  type BudgetUsage,
  type PermissionClassifier,
  type PermissionClassifierInput,
  type PermissionBehavior,
  type PermissionDecision,
  type PermissionDecisionEvent,
  type PermissionLayerSettings,
  type PermissionMode,
  type InheritedPermissionRules,
  type PermissionOptions,
  type PermissionRememberLayer,
  type PermissionRules,
  type PermissionSettingsOptions,
  type PermissionsConfig,
  type RunCheckpoint,
  type Tool,
  type ToolApprovalRemember,
  type ToolPermissionsView,
  type Workspace,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { z } from 'zod';
import {
  PermissionRuleSet,
  readAllowed,
  rememberableRules,
  resolvePermission,
  ruleAllowsCall,
  ruleMatchesCall,
  suggestRule,
} from '../permissions/engine';
import {
  addPermissionRule,
  loadPermissionSettings,
  rememberFile,
  settingsChanged,
  type LoadedPermissionSettings,
} from '../permissions/settings';
import { accessKindOf } from '../permissions/rules';
import { commandWorkspace } from '../permissions/sandbox';

let hostProbeTool: Tool | undefined;

/** The call a connection of a sandboxed command is decided as: a `WebFetch` of its host */
function hostProbe(): Tool {
  hostProbeTool ??= {
    name: 'sandbox_network',
    description: 'A connection a sandboxed command opens to a host',
    parameters: z.object({ url: z.string() }),
    annotations: { readOnlyHint: true },
    access: { kind: 'fetch', url: ({ url }: { url: string }) => url },
    execute: async () => null,
    toJSON: () => ({
      name: 'sandbox_network',
      description: '',
      parameters: { type: 'object', properties: {} },
    }),
  };
  return hostProbeTool;
}

/** Name of the tool a run in `plan` mode presents its plan with */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

const DEFAULT_REMEMBER_LAYERS: readonly PermissionRememberLayer[] = ['session', 'local'];

/** Rules in code, as one `session` layer each */
function codeLayer(
  rules: PermissionOptions | undefined,
  origin: string
): PermissionLayerSettings[] {
  const inherited = rules?.inherited ?? [];
  return [
    ...ownLayer(rules, origin),
    ...inherited.flatMap((entry) => ownLayer(entry, `${origin}, inherited`)),
  ];
}

/** The layer of one list of rules given in code, with where its path patterns start from */
function ownLayer(
  rules: (PermissionRules & { root?: string; cwd?: string }) | undefined,
  origin: string
): PermissionLayerSettings[] {
  if (
    !rules ||
    (rules.allow?.length ?? 0) + (rules.ask?.length ?? 0) + (rules.deny?.length ?? 0) === 0
  ) {
    return [];
  }
  return [
    {
      layer: 'session',
      origin,
      ...(rules.allow && { allow: [...rules.allow] }),
      ...(rules.ask && { ask: [...rules.ask] }),
      ...(rules.deny && { deny: [...rules.deny] }),
      ...(rules.root !== undefined && { anchor: rules.root }),
      ...(rules.cwd !== undefined && { cwd: rules.cwd }),
    },
  ];
}

/**
 * The permissions of a runtime: its configuration, the settings files it reads (kept until one
 * of them changes) and the rules a person allowed for a session, by thread
 */
export class PermissionService {
  private readonly settingsCache = new Map<string, Promise<LoadedPermissionSettings>>();
  private readonly warned = new Set<string>();
  private readonly sessionRules = new Map<
    string,
    Required<Pick<PermissionRules, 'allow' | 'deny'>>
  >();

  constructor(
    readonly config: PermissionsConfig | undefined,
    private readonly classifierOf: (
      config: PermissionsConfig['classifier']
    ) => PermissionClassifier | undefined
  ) {}

  /** The settings options, when the runtime reads settings files */
  get settingsOptions(): PermissionSettingsOptions | undefined {
    const settings = this.config?.settings;
    if (settings === undefined || settings === false) return undefined;
    return settings === true ? {} : settings;
  }

  classifier(): PermissionClassifier | undefined {
    return this.config?.classifier ? this.classifierOf(this.config.classifier) : undefined;
  }

  /** The layers of the settings files for the project at `root`, read again once a file changed */
  async settingsLayers(root: string): Promise<PermissionLayerSettings[]> {
    const options = this.settingsOptions;
    if (!options) return [];
    let loading = this.settingsCache.get(root);
    if (loading) {
      const loaded = await loading.catch(() => undefined);
      if (!loaded || (await settingsChanged(loaded.files, loaded.dirs))) loading = undefined;
    }
    if (!loading) {
      loading = loadPermissionSettings(root, options);
      this.settingsCache.set(root, loading);
    }
    const loaded = await loading;
    for (const warning of loaded.warnings) {
      if (this.warned.has(warning)) continue;
      this.warned.add(warning);
      getLogger().warn('Permission settings', { warning });
    }
    return loaded.layers;
  }

  forget(root: string): void {
    this.settingsCache.delete(root);
  }

  /** The rules a person allowed (or refused, with `deny`) for the session of `threadId` */
  rememberedFor(threadId: string, behavior: 'allow' | 'deny' = 'allow'): string[] {
    return [...(this.sessionRules.get(threadId)?.[behavior] ?? [])];
  }

  rememberForSession(threadId: string, rule: string, behavior: 'allow' | 'deny' = 'allow'): void {
    const rules = this.sessionRules.get(threadId) ?? { allow: [], deny: [] };
    const list = [...rules[behavior]];
    if (!list.includes(rule)) list.push(rule);
    this.sessionRules.set(threadId, { ...rules, [behavior]: list });
  }

  warnOnce(message: string, details: Record<string, unknown> = {}): void {
    const key = `${message}\n${JSON.stringify(details)}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    getLogger().warn(message, details);
  }
}

/** Where a run's permission decisions go besides the caller's result */
export type PermissionRecorder = (event: PermissionDecisionEvent) => Promise<void>;

/** Permissions in code, and what added them */
export interface PermissionScope {
  options: PermissionOptions | undefined;
  origin: string;
}

/** What a run's permissions are made of */
export interface RunPermissionsOptions {
  service: PermissionService;
  threadId: string;
  /** The runtime's permissions */
  runtime: PermissionScope;
  /** The permissions of the agent the run is in */
  agent: PermissionScope;
  /** The run's own permissions, `RunOptions.permissions` */
  run: PermissionOptions | undefined;
  /** What the paused run kept, when it is resumed */
  checkpoint?: RunCheckpoint['permissions'];
  /** The project root of the settings files and of `/path` patterns of rules in code */
  root: string;
  record: PermissionRecorder;
}

/** What a decision needs to know about the call beyond its tool and arguments */
export interface PermissionCall {
  toolCallId: string;
  /** Whether the call needs approval without rules: its tool's own setting and the guardrails */
  needsApproval: boolean;
  /**
   * Whether the guardrails (not the tool's own setting) make the call need approval: a command the
   * workspace's OS sandbox runs skips only the tool's own approval
   */
  guardrailsApproval?: boolean;
  workspace?: Workspace;
  /** Rules of the run's active skills, by skill name */
  skillRules?: ReadonlyArray<{ name: string; rules: readonly string[] }>;
  /** What the `auto` classifier reads about the call, besides why it would ask */
  classifierInput?: () => Omit<PermissionClassifierInput, 'reason'>;
  /** A mode to decide in instead of the run's */
  mode?: PermissionMode;
  /** The budget the model call of the `auto` classifier would pass, so the call is not made */
  classifierBudget?: () => BudgetUsage | undefined;
  /**
   * A hook allowed the call (`beforeToolCall` returned `allow`): what only the mode or the tool's
   * own approval setting would ask for runs without asking, and the `auto` classifier is not asked.
   * Deny and ask rules, and the asks that guard a deny rule, still apply
   */
  allowedByHook?: boolean;
}

/**
 * Thrown by {@link RunPermissions.decide} when classifying a call would pass a budget: the call
 * is not classified, and the run stops at the budget as before a model call
 */
export class ClassifierBudgetReached extends Error {
  constructor(readonly usage: BudgetUsage) {
    super(`The auto mode classifier would pass a budget (${usage.scope} ${usage.metric})`);
    this.name = 'ClassifierBudgetReached';
  }
}

/** The run's own rules: those of the run's options, else those its checkpoint kept, list by list */
function runScope(
  run: PermissionOptions | undefined,
  kept: RunCheckpoint['permissions'] | undefined
): PermissionOptions | undefined {
  const rules = kept?.rules;
  if (!run && !rules) return undefined;
  const allow = run?.allow ?? rules?.allow;
  const ask = run?.ask ?? rules?.ask;
  const deny = run?.deny ?? rules?.deny;
  const inherited = run?.inherited ?? rules?.inherited;
  return {
    ...(run?.mode !== undefined && { mode: run.mode }),
    ...(allow && { allow: [...allow] }),
    ...(ask && { ask: [...ask] }),
    ...(deny && { deny: [...deny] }),
    ...(inherited && { inherited: inherited.map((entry) => ({ ...entry })) }),
  };
}

/**
 * The permissions of one run: its mode, which can change while it goes on, the rules of every
 * layer, and the record of each decision. Without any permission setup (`active` false) a call
 * asks exactly when its tool needs approval, and nothing is recorded, as before
 */
export class RunPermissions {
  private activated: boolean;
  private currentMode: PermissionMode;
  private readonly remembered: string[];
  private readonly rememberedDeny: string[];
  private readonly rememberedFiles: PermissionLayerSettings[] = [];
  private settings: PermissionLayerSettings[] = [];
  private readonly listeners = new Set<(mode: PermissionMode) => void>();
  private agentScope: PermissionScope;
  private readonly ownScope: PermissionOptions | undefined;
  private root: string;
  private readonly planTools = new Set<Tool>();

  private constructor(private readonly options: RunPermissionsOptions) {
    const { service, checkpoint } = options;
    this.agentScope = options.agent;
    this.ownScope = runScope(options.run, checkpoint);
    this.root = options.root;
    this.remembered = [
      ...service.rememberedFor(options.threadId),
      ...(checkpoint?.remembered?.allow ?? []),
    ];
    this.rememberedDeny = [
      ...service.rememberedFor(options.threadId, 'deny'),
      ...(checkpoint?.remembered?.deny ?? []),
    ];
    this.activated =
      service.config !== undefined ||
      options.runtime.options !== undefined ||
      options.agent.options !== undefined ||
      this.ownScope !== undefined ||
      checkpoint !== undefined ||
      this.remembered.length > 0 ||
      this.rememberedDeny.length > 0;
    this.currentMode = 'default';
  }

  static async create(options: RunPermissionsOptions): Promise<RunPermissions> {
    const run = new RunPermissions(options);
    if (!run.active) return run;
    run.settings = await options.service.settingsLayers(options.root);
    const mode =
      options.run?.mode ??
      options.checkpoint?.mode ??
      options.agent.options?.mode ??
      options.runtime.options?.mode ??
      run.rules().defaultMode() ??
      'default';
    const problem = run.modeProblem(mode);
    if (problem) {
      options.service.warnOnce('A permission mode cannot be used, the run starts in default mode', {
        mode,
        problem,
      });
      run.currentMode = 'default';
    } else {
      run.currentMode = mode;
    }
    return run;
  }

  /** Whether the run has permissions set up: a configuration, a mode or rules anywhere */
  get active(): boolean {
    return this.activated;
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  /** A tool of the run `plan` mode runs although it is not read-only, its `exit_plan_mode` */
  allowInPlan(tool: Tool): void {
    this.planTools.add(tool);
  }

  /**
   * Takes the permissions of the agent a run handed over to, and the settings files of its
   * project, from the next decision on
   */
  async switchAgent(agent: PermissionScope, root: string): Promise<void> {
    this.agentScope = agent;
    if (agent.options !== undefined) this.activated = true;
    if (root !== this.root) {
      this.root = root;
      if (this.activated) this.settings = await this.options.service.settingsLayers(root);
    }
    const problem = this.activated ? this.modeProblem(this.currentMode) : undefined;
    if (problem) {
      this.options.service.warnOnce(
        'The permission mode cannot be used after the handoff, the run goes on in default mode',
        {
          mode: this.currentMode,
          problem,
        }
      );
      this.currentMode = 'default';
      for (const listener of this.listeners) listener('default');
    }
  }

  /** Hears every mode change */
  onModeChange(listener: (mode: PermissionMode) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private modeProblem(mode: PermissionMode): string | undefined {
    const rules = this.rules();
    if (rules.disables(mode)) return `a settings file disables ${mode} mode`;
    if (mode === 'auto' && !this.options.service.classifier()) {
      return 'auto mode needs permissions.classifier';
    }
    return undefined;
  }

  /**
   * Switches the mode from the next decision on
   *
   * @throws CogitatorError `CONFIGURATION_ERROR` for a mode a settings file disables, or `auto`
   * without a classifier
   */
  setMode(mode: PermissionMode): void {
    const problem = this.modeProblem(mode);
    if (problem) {
      throw new CogitatorError({
        message: `Cannot switch to ${mode} mode: ${problem}`,
        code: ErrorCode.CONFIGURATION_ERROR,
      });
    }
    this.activated = true;
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    for (const listener of this.listeners) listener(mode);
  }

  private scopes(): PermissionScope[] {
    return [this.options.runtime, this.agentScope, { options: this.ownScope, origin: 'run' }];
  }

  /** The rules of every layer, those of active skills among the `session` ones */
  rules(skillRules: PermissionCall['skillRules'] = []): PermissionRuleSet {
    return new PermissionRuleSet([
      ...this.settings,
      ...this.rememberedFiles,
      ...this.scopes().flatMap((scope) => codeLayer(scope.options, scope.origin)),
      ...codeLayer({ allow: this.remembered, deny: this.rememberedDeny }, 'remembered'),
      ...skillRules.flatMap((skill) => codeLayer({ allow: skill.rules }, `skill:${skill.name}`)),
    ]);
  }

  /** Whether a bare deny rule names `tool`, so the model is not offered it */
  hides(tool: Tool): boolean {
    return this.active && this.rules().deniesWhole(tool);
  }

  /** What tools see of the run's permissions, `context.permissions` */
  view(workspace?: Workspace): ToolPermissionsView | undefined {
    if (!this.active) return undefined;
    const merged = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
    for (const scope of this.scopes()) {
      for (const rules of [scope.options, ...(scope.options?.inherited ?? [])]) {
        merged.allow.push(...(rules?.allow ?? []));
        merged.ask.push(...(rules?.ask ?? []));
        merged.deny.push(...(rules?.deny ?? []));
      }
    }
    merged.allow.push(...this.remembered);
    merged.deny.push(...this.rememberedDeny);
    const context = this.context(workspace);
    const here = {
      root: this.root,
      cwd: workspace ? resolve(workspace.root, workspace.cwd) : this.root,
    };
    const inherited: InheritedPermissionRules[] = [];
    const pass = (rules: PermissionRules | undefined) => {
      const lists = {
        ...(rules?.allow?.length && { allow: [...rules.allow] }),
        ...(rules?.ask?.length && { ask: [...rules.ask] }),
        ...(rules?.deny?.length && { deny: [...rules.deny] }),
      };
      if (Object.keys(lists).length > 0) inherited.push({ ...lists, ...here });
    };
    for (const scope of this.scopes()) {
      pass(scope.options);
      inherited.push(...(scope.options?.inherited ?? []).map((entry) => ({ ...entry })));
    }
    pass({ allow: this.remembered, deny: this.rememberedDeny });
    return {
      mode: this.currentMode,
      rules: merged,
      inherited,
      canRead: (path) => readAllowed(path, this.rules(), context),
      decideHost: (host, port) => this.decideHost(host, port, workspace),
      allowHost: (host) => this.allowHost(host),
    };
  }

  /**
   * How a host a sandboxed command connects to is decided when no sandbox list decides it: as a
   * `WebFetch(domain:...)` call, a deny rule refusing it and an allow rule letting it through,
   * else by the mode: `bypassPermissions` lets it through, `auto` and `dontAsk` refuse it (no
   * classifier sees a connection), the others ask a person
   */
  async decideHost(host: string, port: number, workspace?: Workspace): Promise<PermissionBehavior> {
    const mode = this.currentMode;
    const shown = host.includes(':') ? `[${host}]` : host;
    const decision = await resolvePermission(
      hostProbe(),
      { url: `https://${shown}:${port}/` },
      {
        mode: mode === 'auto' || mode === 'plan' ? 'default' : mode,
        rules: this.rules(),
        needsApproval: true,
        ...this.context(workspace),
      }
    );
    if (decision.decision === 'ask' && mode === 'auto') return 'deny';
    return decision.decision;
  }

  /** Allows `host` for the rest of the session, as an answer allowing a connection to it does */
  allowHost(host: string): void {
    const rule = `WebFetch(domain:${host})`;
    if (!this.remembered.includes(rule)) this.remembered.push(rule);
    this.options.service.rememberForSession(this.options.threadId, rule);
  }

  private context(workspace: Workspace | undefined) {
    return { ...(workspace && { workspace }), cwd: this.root, projectRoot: this.root };
  }

  /** The permission decision for a call of `tool` with `args` */
  async decide(
    tool: Tool,
    args: Record<string, unknown>,
    call: PermissionCall
  ): Promise<PermissionDecision> {
    if (!this.active) {
      if (accessKindOf(tool) === 'command' && commandWorkspace(tool, call.workspace)?.sandbox) {
        return resolvePermission(tool, args, {
          mode: 'default',
          rules: new PermissionRuleSet([]),
          needsApproval: call.needsApproval,
          ...(call.guardrailsApproval && { guardrailsApproval: true }),
          ...(call.allowedByHook && { allowedByHook: true }),
          ...this.context(call.workspace),
        });
      }
      if (call.needsApproval && call.allowedByHook) {
        return {
          decision: 'allow',
          reason: 'Allowed by a hook',
          decidedBy: 'hook',
          mode: 'default',
        };
      }
      return call.needsApproval
        ? {
            decision: 'ask',
            reason: `${tool.name} needs approval for this call`,
            decidedBy: 'tool',
            mode: 'default',
          }
        : {
            decision: 'allow',
            reason: `${tool.name} needs no approval`,
            decidedBy: 'default',
            mode: 'default',
          };
    }
    const mode = call.mode ?? this.currentMode;
    const classifier = mode === 'auto' ? this.options.service.classifier() : undefined;
    const input = call.classifierInput;
    let reached: BudgetUsage | undefined;
    const decision = await resolvePermission(tool, args, {
      mode,
      rules: this.rules(call.skillRules),
      needsApproval: call.needsApproval,
      ...(call.guardrailsApproval && { guardrailsApproval: true }),
      ...(call.allowedByHook && { allowedByHook: true }),
      ...this.context(call.workspace),
      planTools: this.planTools,
      trustRepository: this.options.service.settingsOptions?.trusted === true,
      ...(classifier &&
        input && {
          classify: (reason: string) => {
            reached = call.classifierBudget?.();
            if (reached) throw new ClassifierBudgetReached(reached);
            return classifier.classify({ ...input(), reason });
          },
        }),
    });
    if (reached) throw new ClassifierBudgetReached(reached);
    return decision;
  }

  /** The rule an "always allow" answer to the call saves by default */
  suggest(tool: Tool, args: Record<string, unknown>, workspace?: Workspace): string | undefined {
    if (!this.active) return undefined;
    return suggestRule(tool, args, this.context(workspace));
  }

  /**
   * Saves the rule of an "always allow" answer (an allow rule) or an "always reject" one (a deny
   * rule, `behavior: 'deny'`): to the run and the thread's session for `session` (and whenever
   * the runtime reads no settings files), else to the layer's settings file. Only the suggested
   * rule or the exact call may be saved, and only when it covers the call
   */
  async remember(
    tool: Tool,
    args: Record<string, unknown>,
    choice: true | ToolApprovalRemember,
    workspace?: Workspace,
    behavior: 'allow' | 'deny' = 'allow'
  ): Promise<
    { rule: string; layer: PermissionRememberLayer; behavior: 'allow' | 'deny' } | undefined
  > {
    if (!this.active) return undefined;
    const { service, threadId } = this.options;
    const root = this.root;
    const config = service.config;
    const context = this.context(workspace);
    const answer = behavior === 'allow' ? '"always allow"' : '"always reject"';
    const offered = rememberableRules(tool, args, context);
    const rule = (choice === true ? undefined : choice.rule) ?? offered[0];
    if (!rule) {
      service.warnOnce(
        `An ${answer} answer has no rule to save, the call is ${behavior === 'allow' ? 'approved' : 'refused'} once`,
        { tool: tool.name }
      );
      return undefined;
    }
    const covers =
      behavior === 'allow'
        ? await ruleAllowsCall(rule, tool, args, context, root)
        : (await ruleMatchesCall(rule, tool, args, context, root)) === true;
    if (!offered.includes(rule.trim()) || !covers) {
      service.warnOnce(
        `An ${answer} rule is broader than the call it answers or does not cover it, it is not saved`,
        { tool: tool.name, rule }
      );
      return undefined;
    }
    const requested = choice === true ? undefined : choice.layer;
    const allowedLayers = config?.rememberLayers ?? DEFAULT_REMEMBER_LAYERS;
    if (requested && !allowedLayers.includes(requested)) {
      service.warnOnce(`An ${answer} answer names a layer it may not save to`, {
        layer: requested,
      });
    }
    let layer: PermissionRememberLayer =
      requested && allowedLayers.includes(requested) ? requested : (config?.rememberIn ?? 'local');
    const settings = service.settingsOptions;
    if (layer !== 'session' && !settings) layer = 'session';
    if (layer === 'session') {
      const kept = behavior === 'allow' ? this.remembered : this.rememberedDeny;
      if (!kept.includes(rule)) kept.push(rule);
      service.rememberForSession(threadId, rule, behavior);
      return { rule, layer, behavior };
    }
    const file = rememberFile(layer, root, settings);
    await addPermissionRule(file, behavior, rule);
    service.forget(root);
    this.rememberedFiles.push({
      layer,
      origin: file,
      anchor: layer === 'user' ? resolve(file, '..') : root,
      ...(behavior === 'allow' ? { allow: [rule] } : { deny: [rule] }),
    });
    return { rule, layer, behavior };
  }

  /** Records a decision: the caller hears it and the thread keeps it, once permissions are set up */
  async record(event: PermissionDecisionEvent): Promise<void> {
    if (!this.active) return;
    await this.options.record(event);
  }

  /** What a checkpoint keeps of the run's permissions */
  state(): RunCheckpoint['permissions'] {
    if (!this.active) return undefined;
    const own = this.ownScope;
    const rules = own && {
      ...(own.allow && { allow: [...own.allow] }),
      ...(own.ask && { ask: [...own.ask] }),
      ...(own.deny && { deny: [...own.deny] }),
      ...(own.inherited && { inherited: own.inherited.map((entry) => ({ ...entry })) }),
    };
    return {
      mode: this.currentMode,
      ...((this.remembered.length > 0 || this.rememberedDeny.length > 0) && {
        remembered: {
          ...(this.remembered.length > 0 && { allow: [...this.remembered] }),
          ...(this.rememberedDeny.length > 0 && { deny: [...this.rememberedDeny] }),
        },
      }),
      ...(rules && Object.keys(rules).length > 0 && { rules }),
    };
  }
}

/**
 * The permission mode of a run started with `cogitator.start()`, for its handle: a mode set before
 * the run is ready is applied once it is, and refused with a warning when it cannot be used
 */
export class PermissionModeControl {
  private run?: RunPermissions;
  private pending?: PermissionMode;

  get mode(): PermissionMode | undefined {
    return this.run?.mode ?? this.pending;
  }

  set(mode: PermissionMode): void {
    if (this.run) this.run.setMode(mode);
    else this.pending = mode;
  }

  attach(run: RunPermissions): void {
    this.run = run;
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return;
    try {
      run.setMode(pending);
    } catch (error) {
      getLogger().warn('The permission mode set on the run handle cannot be used', {
        mode: pending,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
