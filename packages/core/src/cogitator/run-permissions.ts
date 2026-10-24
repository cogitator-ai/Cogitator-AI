import { resolve } from 'node:path';
import {
  CogitatorError,
  ErrorCode,
  type PermissionClassifier,
  type PermissionClassifierInput,
  type PermissionDecision,
  type PermissionDecisionEvent,
  type PermissionLayerSettings,
  type PermissionMode,
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
import {
  PermissionRuleSet,
  resolvePermission,
  ruleAllowsCall,
  suggestRule,
} from '../permissions/engine';
import {
  addAllowRule,
  loadPermissionSettings,
  rememberFile,
  settingsChanged,
  type LoadedPermissionSettings,
} from '../permissions/settings';

/** Name of the tool a run in `plan` mode presents its plan with */
export const EXIT_PLAN_MODE = 'exit_plan_mode';

const DEFAULT_REMEMBER_LAYERS: readonly PermissionRememberLayer[] = ['session', 'local'];

/** Rules in code, as one `session` layer each */
function codeLayer(rules: PermissionRules | undefined, origin: string): PermissionLayerSettings[] {
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
  private readonly sessionRules = new Map<string, string[]>();

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
      if (!loaded || (await settingsChanged(loaded.files))) loading = undefined;
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

  rememberedFor(threadId: string): string[] {
    return [...(this.sessionRules.get(threadId) ?? [])];
  }

  rememberForSession(threadId: string, rule: string): void {
    const rules = this.sessionRules.get(threadId) ?? [];
    if (!rules.includes(rule)) rules.push(rule);
    this.sessionRules.set(threadId, rules);
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

/** What a run's permissions are made of */
export interface RunPermissionsOptions {
  service: PermissionService;
  threadId: string;
  /** The runtime's, the agent's and the run's permissions, lowest first */
  scopes: Array<{ options: PermissionOptions | undefined; origin: string }>;
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
  workspace?: Workspace;
  /** Rules of the run's active skills, by skill name */
  skillRules?: ReadonlyArray<{ name: string; rules: readonly string[] }>;
  /** What the `auto` classifier reads about the call, besides why it would ask */
  classifierInput?: () => Omit<PermissionClassifierInput, 'reason'>;
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
  private readonly rememberedFiles: PermissionLayerSettings[] = [];
  private settings: PermissionLayerSettings[] = [];
  private readonly listeners = new Set<(mode: PermissionMode) => void>();

  private constructor(private readonly options: RunPermissionsOptions) {
    const { service, scopes, checkpoint } = options;
    this.activated =
      service.config !== undefined ||
      scopes.some((scope) => scope.options !== undefined) ||
      checkpoint !== undefined;
    this.remembered = [
      ...service.rememberedFor(options.threadId),
      ...(checkpoint?.remembered?.allow ?? []),
    ];
    this.currentMode = 'default';
  }

  static async create(options: RunPermissionsOptions): Promise<RunPermissions> {
    const run = new RunPermissions(options);
    if (!run.active) return run;
    run.settings = await options.service.settingsLayers(options.root);
    const requested = [...options.scopes]
      .reverse()
      .find((scope) => scope.options?.mode !== undefined)?.options?.mode;
    const fromRun = options.scopes.at(-1)?.options?.mode;
    const mode =
      fromRun ?? options.checkpoint?.mode ?? requested ?? run.rules().defaultMode() ?? 'default';
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

  /** The rules of every layer, those of active skills among the `session` ones */
  rules(skillRules: PermissionCall['skillRules'] = []): PermissionRuleSet {
    return new PermissionRuleSet([
      ...this.settings,
      ...this.rememberedFiles,
      ...this.options.scopes.flatMap((scope) => codeLayer(scope.options, scope.origin)),
      ...codeLayer({ allow: this.remembered }, 'remembered'),
      ...skillRules.flatMap((skill) => codeLayer({ allow: skill.rules }, `skill:${skill.name}`)),
    ]);
  }

  /** What tools see of the run's permissions, `context.permissions` */
  view(): ToolPermissionsView | undefined {
    if (!this.active) return undefined;
    const merged = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
    for (const scope of this.options.scopes) {
      merged.allow.push(...(scope.options?.allow ?? []));
      merged.ask.push(...(scope.options?.ask ?? []));
      merged.deny.push(...(scope.options?.deny ?? []));
    }
    merged.allow.push(...this.remembered);
    return { mode: this.currentMode, rules: merged };
  }

  /** The permission decision for a call of `tool` with `args` */
  async decide(
    tool: Tool,
    args: Record<string, unknown>,
    call: PermissionCall
  ): Promise<PermissionDecision> {
    if (!this.active) {
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
    const classifier = this.currentMode === 'auto' ? this.options.service.classifier() : undefined;
    const input = call.classifierInput;
    return resolvePermission(tool, args, {
      mode: this.currentMode,
      rules: this.rules(call.skillRules),
      needsApproval: call.needsApproval,
      ...(call.workspace && { workspace: call.workspace }),
      cwd: this.options.root,
      projectRoot: this.options.root,
      planTools: new Set([EXIT_PLAN_MODE]),
      ...(classifier &&
        input && {
          classify: (reason: string) => classifier.classify({ ...input(), reason }),
        }),
    });
  }

  /** The rule an "always allow" answer to the call saves by default */
  suggest(tool: Tool, args: Record<string, unknown>, workspace?: Workspace): string | undefined {
    if (!this.active) return undefined;
    return suggestRule(tool, args, {
      ...(workspace && { workspace }),
      cwd: this.options.root,
      projectRoot: this.options.root,
    });
  }

  /**
   * Saves the allow rule of an "always allow" answer: to the run and the thread's session for
   * `session` (and whenever the runtime reads no settings files), else to the layer's settings
   * file. A rule that does not allow the call it answers is not saved
   */
  async remember(
    tool: Tool,
    args: Record<string, unknown>,
    choice: true | ToolApprovalRemember,
    workspace?: Workspace
  ): Promise<{ rule: string; layer: PermissionRememberLayer } | undefined> {
    if (!this.active) return undefined;
    const { service, root, threadId } = this.options;
    const config = service.config;
    const rule = (choice === true ? undefined : choice.rule) ?? this.suggest(tool, args, workspace);
    if (!rule) {
      service.warnOnce('An "always allow" answer has no rule to save, the call is approved once', {
        tool: tool.name,
      });
      return undefined;
    }
    const context = { ...(workspace && { workspace }), cwd: root, projectRoot: root };
    if (!(await ruleAllowsCall(rule, tool, args, context, root))) {
      service.warnOnce(
        'An "always allow" rule does not cover the call it answers, it is not saved',
        {
          tool: tool.name,
          rule,
        }
      );
      return undefined;
    }
    const requested = choice === true ? undefined : choice.layer;
    const allowedLayers = config?.rememberLayers ?? DEFAULT_REMEMBER_LAYERS;
    if (requested && !allowedLayers.includes(requested)) {
      service.warnOnce('An "always allow" answer names a layer it may not save to', {
        layer: requested,
      });
    }
    let layer: PermissionRememberLayer =
      requested && allowedLayers.includes(requested) ? requested : (config?.rememberIn ?? 'local');
    const settings = service.settingsOptions;
    if (layer !== 'session' && !settings) layer = 'session';
    if (layer === 'session') {
      if (!this.remembered.includes(rule)) this.remembered.push(rule);
      service.rememberForSession(threadId, rule);
      return { rule, layer };
    }
    const file = rememberFile(layer, root, settings);
    await addAllowRule(file, rule);
    service.forget(root);
    this.rememberedFiles.push({
      layer,
      origin: file,
      anchor: layer === 'user' ? resolve(file, '..') : root,
      allow: [rule],
    });
    return { rule, layer };
  }

  /** Records a decision: the caller hears it and the thread keeps it, once permissions are set up */
  async record(event: PermissionDecisionEvent): Promise<void> {
    if (!this.active) return;
    await this.options.record(event);
  }

  /** What a checkpoint keeps of the run's permissions */
  state(): RunCheckpoint['permissions'] {
    if (!this.active) return undefined;
    return {
      mode: this.currentMode,
      ...(this.remembered.length > 0 && { remembered: { allow: [...this.remembered] } }),
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
