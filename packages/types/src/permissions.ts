/**
 * Permission rules, modes and session budgets: what decides whether a tool call runs, asks a
 * person or is refused, and how much a session may spend
 */

/**
 * What a permission check says about a tool call: run it (`allow`), ask a person first (`ask`,
 * the approval flow of `RunOptions.onApproval`), or refuse it (`deny`, the model reads why)
 */
export type PermissionBehavior = 'allow' | 'ask' | 'deny';

/**
 * How a run decides the calls no rule decides, the modes of Claude Code:
 * - `default`: a call asks when its tool needs approval (`requiresApproval`, the guardrails), and
 *   every edit (tools whose `access` is `edit`) asks unless an allow rule covers it
 * - `acceptEdits`: as `default`, and edits of files inside the workspace (tools whose `access`
 *   is `edit`, and `mkdir`, `touch`, `mv`, `cp` commands on workspace paths) run without asking
 * - `plan`: only read-only tools of the runtime (`annotations.readOnlyHint` or `access.kind`
 *   `read`, never those an MCP server describes) and read-only shell commands run, every other call
 *   is refused until the model presents its plan with `exit_plan_mode` and a person approves it
 * - `auto`: a classifier model decides each call that would ask, with a reason in the audit log.
 *   An `ask` rule still asks, and a classifier that fails falls back to asking
 * - `dontAsk`: every call that would ask is refused instead, what the rules allow still runs
 * - `bypassPermissions`: every call runs except the ones a `deny` rule refuses (and a command line
 *   that could hide a denied command asks). Only for isolated environments (a container, a VM)
 */
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

/** Every {@link PermissionMode}, in the order of the type */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

/**
 * Where a rule comes from, highest first: `managed` (the organization's policy files), `session`
 * (rules in code: the run's, the agent's, the runtime's, the ones a person allowed for the
 * session and the `allowed-tools` of active skills), `local` (`.claude/settings.local.json`,
 * `.cogitator/settings.local.json`), `project` (`.claude/settings.json`,
 * `.cogitator/settings.json`) and `user` (`~/.claude/settings.json`, `~/.cogitator/settings.json`).
 * A `deny` of any layer wins over an `allow` of any layer, the layer decides which rule a decision
 * names and which `defaultMode` applies
 */
export type PermissionLayer = 'managed' | 'session' | 'local' | 'project' | 'user';

/** Every {@link PermissionLayer}, highest first */
export const PERMISSION_LAYERS: readonly PermissionLayer[] = [
  'managed',
  'session',
  'local',
  'project',
  'user',
];

/** The layers an "always allow" answer can save its rule to */
export type PermissionRememberLayer = 'session' | 'local' | 'project' | 'user';

/**
 * Rules in the grammar of Claude Code's `permissions` settings. A rule is a tool name, or a tool
 * name with a specifier: `Bash(git push *)` (`Bash(git push:*)` is the same), `Edit(src/**)`,
 * `Read(//etc/**)`, `mcp__github__create_issue`, `send_email(to:*@example.com)`. Claude Code's
 * names map to the workspace tools (`Bash` to `run_command`, `Read` to `read_file`, `Edit` to
 * `edit_file`, `Write` to `write_file`, `Glob` to `glob`, `Grep` to `grep`) and a tool's own name
 * works as it is
 */
export interface PermissionRules {
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}

/** The `permissions` of a settings file, as Claude Code writes them */
export interface PermissionSettingsFile extends PermissionRules {
  defaultMode?: PermissionMode;
  /** `'disable'` keeps `bypassPermissions` from being used, from any layer */
  disableBypassPermissionsMode?: 'disable';
  /** `'disable'` keeps `auto` from being used, from any layer */
  disableAutoMode?: 'disable';
  /** In managed settings: the rules of the other files are ignored */
  allowManagedPermissionRulesOnly?: boolean;
  /** Directories outside the workspace that `acceptEdits` treats as inside */
  additionalDirectories?: readonly string[];
}

/** The rules and settings of one file (or of the code, for `session`) */
export interface PermissionLayerSettings extends PermissionSettingsFile {
  layer: PermissionLayer;
  /** The file the settings were read from */
  origin?: string;
  /**
   * The directory a rule's `/path` pattern starts from: the project root for project and local
   * files, the settings directory for user and managed ones
   */
  anchor?: string;
  /**
   * The directory a rule's relative path pattern (`secrets/**`, `./src/x`) starts from, instead of
   * the working directory of the call: for rules a run passed on to the delegated run it started
   */
  cwd?: string;
}

/** A rule a decision applied */
export interface PermissionRuleRef {
  /** The rule as written, such as `Bash(git push *)` */
  rule: string;
  behavior: PermissionBehavior;
  layer: PermissionLayer;
  /** The file the rule came from, or what added it in code (`run`, `agent`, `skill:<name>`...) */
  origin?: string;
}

/**
 * What made a decision: a rule, the run's mode, the tool's own approval setting (or the
 * guardrails), the `auto` classifier, a person answering the approval, a hook or middleware
 * (`beforeToolCall`, `decideApproval`), or nothing at all (a call that needs no approval runs)
 */
export type PermissionDecider =
  'rule' | 'mode' | 'tool' | 'classifier' | 'user' | 'hook' | 'default';

/** What `resolvePermission` decided for a call */
export interface PermissionDecision {
  decision: PermissionBehavior;
  /** Why, in words a person reads: the rule, the mode or the classifier's reason */
  reason: string;
  /** The rule that decided, when one did */
  rule?: PermissionRuleRef;
  decidedBy: PermissionDecider;
  /** The mode the run was in */
  mode: PermissionMode;
}

/** A decision about one tool call, as `onPermissionDecision` hears it and the log keeps it */
export interface PermissionDecisionEvent extends PermissionDecision {
  toolCallId: string;
  toolName: string;
  /** The arguments the call runs with, when an approval changed them */
  updatedArguments?: Record<string, unknown>;
  /** The rule an "always allow" answer saved, and where */
  remembered?: { rule: string; layer: PermissionRememberLayer };
}

/** What a classifier of `auto` mode reads about a call */
export interface PermissionClassifierInput {
  toolName: string;
  description: string;
  arguments: Record<string, unknown>;
  /** What the user asked the run for */
  request: string;
  /** The newest messages of the conversation, as text, oldest first */
  transcript: readonly string[];
  /** Why the call would ask, without the classifier */
  reason: string;
  signal?: AbortSignal;
}

/** What a classifier of `auto` mode decides */
export interface PermissionClassification {
  decision: 'allow' | 'deny';
  reason: string;
}

/** Decides the calls that would ask in `auto` mode */
export interface PermissionClassifier {
  classify(input: PermissionClassifierInput): Promise<PermissionClassification>;
}

/** The model that classifies calls in `auto` mode */
export interface PermissionClassifierModelConfig {
  /** The model, as `provider/model`, run on this runtime's backends */
  model: string;
  /** Instructions instead of the built-in ones, which ask for a JSON `{ decision, reason }` */
  instructions?: string;
  /** Milliseconds a classification may take before the call asks instead (default 30 000) */
  timeout?: number;
  /** How many newest messages of the conversation the classifier reads (default 12) */
  transcriptMessages?: number;
}

/** Where the settings files of the permission rules are read */
export interface PermissionSettingsOptions {
  /**
   * The project root, whose `.claude/` and `.cogitator/` hold the project and local files.
   * Default: the run's workspace root, else the working directory of the process
   */
  root?: string;
  /** Directory of the user files (default `~/.cogitator` and `CLAUDE_CONFIG_DIR` or `~/.claude`) */
  userDirs?: readonly string[];
  /**
   * Directories of the managed files (`managed-settings.json` and `managed-settings.d/*.json`).
   * Default: Cogitator's and Claude Code's system directories of the platform
   */
  managedDirs?: readonly string[];
  /** Which layers are read (default every one) */
  layers?: readonly Exclude<PermissionLayer, 'session'>[];
  /**
   * Whether the project's files are trusted: an untrusted project's `allow` rules,
   * `additionalDirectories` and `defaultMode` are ignored, its `ask` and `deny` rules apply.
   * Default true, as for an SDK session of Claude Code
   */
  trusted?: boolean;
}

/** Permissions of a run or an agent: its mode and its own rules, in the `session` layer */
export interface PermissionOptions extends PermissionRules {
  mode?: PermissionMode;
  /**
   * Rules a run passes on to a run it starts (`agentAsTool()`), each list with where its path
   * patterns start from, so they name the same paths in a run with another workspace
   */
  inherited?: readonly InheritedPermissionRules[];
}

/** Rules of another run, with the directories their path patterns start from there */
export interface InheritedPermissionRules extends PermissionRules {
  /** Where `/path` patterns start from: the project root of the run they come from */
  root: string;
  /** Where relative path patterns start from: the working directory of that run */
  cwd: string;
}

/** Permissions of a runtime */
export interface PermissionsConfig extends PermissionOptions {
  /**
   * Read rules from Claude Code compatible settings files: `true` for the default places, or
   * where to read. Off by default, the runtime then uses only the rules given in code
   */
  settings?: boolean | PermissionSettingsOptions;
  /** The classifier of `auto` mode: a model, or your own */
  classifier?: PermissionClassifierModelConfig | PermissionClassifier;
  /** Where an "always allow" answer saves its rule when it names no layer (default `local`) */
  rememberIn?: PermissionRememberLayer;
  /**
   * The layers an answer may name for its rule (default `session` and `local`): an answer from a
   * client asking for another is saved to `rememberIn`
   */
  rememberLayers?: readonly PermissionRememberLayer[];
}

/** What a run is allowed to do, as its tools see it in `context.permissions` */
export interface ToolPermissionsView {
  readonly mode: PermissionMode;
  /** The `session` rules of the run, merged */
  readonly rules: Required<PermissionRules>;
  /**
   * The `session` rules of the run with where their path patterns start from, for passing on to
   * a run the tool starts (`RunOptions.permissions.inherited`)
   */
  readonly inherited: readonly InheritedPermissionRules[];
  /**
   * Whether no `Read(...)` deny or ask rule covers `path` (relative to the workspace root, or
   * absolute), for tools that read or list many files: `grep`, `glob` and `list_files` leave out
   * what a rule refuses or asks for, and say how many files they left out
   */
  canRead(path: string): Promise<boolean>;
}

/** A limit of money, tokens or tool calls */
export interface BudgetLimits {
  /** USD, as the run's `usage.cost` counts it */
  maxCostUsd?: number;
  /** Input and output tokens */
  maxTokens?: number;
  /** Tool calls run */
  maxToolCalls?: number;
}

/**
 * Budgets of a session (a thread, across its runs) and of each agent in it. A run that reaches one
 * pauses with an interrupt of kind `budget` before its next model call or tool turn, instead of
 * failing: resume with `{ action: 'continue', limit }` to raise the limit, `{ action: 'continue' }`
 * to go on past it for the rest of the run, or `{ action: 'stop' }` to end the run with what it has
 */
export interface SessionBudgetConfig {
  /** What every run of a thread may spend together */
  session?: BudgetLimits;
  /** What each agent may spend in a thread, unless the agent sets its own `budget` */
  agent?: BudgetLimits;
  /** Share of a limit at which `onWarning` hears of it, once per run (default 0.8) */
  warnAt?: number;
  /**
   * Whether an answer to a budget interrupt may go on past the limit or raise it
   * (`{ action: 'continue', limit? }`). Off by default: a client can only stop the run, and raising
   * a limit is the host's decision, by resuming with a higher `budget` of its own
   */
  allowRaise?: boolean;
  onWarning?: (warning: BudgetWarning) => void;
}

/** What a budget counts */
export type BudgetMetric = 'cost' | 'tokens' | 'toolCalls';

/**
 * Whose spending a limit bounds: the thread's (`session`), an agent's in the thread (`agent`), the
 * run's (`limits.maxTokensPerRun`, the cost routing `maxCostPerRun`), or the cost routing hourly
 * and daily budgets (`hour`, `day`)
 */
export type BudgetScope = 'session' | 'agent' | 'run' | 'hour' | 'day';

/** How much of a limit is spent */
export interface BudgetUsage {
  scope: BudgetScope;
  metric: BudgetMetric;
  used: number;
  limit: number;
  /** The agent of an `agent` budget */
  agentId?: string;
}

/** A budget passed its warning share, see `SessionBudgetConfig.warnAt` */
export interface BudgetWarning extends BudgetUsage {
  runId: string;
  threadId: string;
}

/** Money, tokens and tool calls spent */
export interface SpendTotals {
  costUsd: number;
  tokens: number;
  toolCalls: number;
}

/** What was spent, in all and by agent id */
export interface BudgetSpend extends SpendTotals {
  agents?: Record<string, SpendTotals>;
}

/** What a session spent so far, as the thread keeps it (metadata `budget`) */
export interface SessionSpend extends BudgetSpend {
  /**
   * Limits a `continue` answer raised for the session, by `session.<metric>` or
   * `agent:<id>.<metric>` (metric `cost`, `tokens` or `toolCalls`)
   */
  raised?: Record<string, number>;
}

/** The answer to an interrupt of kind `budget` */
export type BudgetResponse = { action: 'continue'; limit?: number } | { action: 'stop' };

/** The answer to an interrupt of kind `plan` */
export interface PlanResponse {
  approved: boolean;
  /**
   * The mode the run goes on in once the plan is approved (default `default`). An answer cannot
   * pick `auto` or `bypassPermissions`: the host switches to those with `setPermissionMode()`
   */
  mode?: 'default' | 'acceptEdits' | 'dontAsk';
  /** What to change in the plan, for a plan not approved */
  feedback?: string;
}
