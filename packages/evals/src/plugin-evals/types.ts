import type { CogitatorConfig, LocalWorkspaceExecConfig } from '@cogitator-ai/core';

/**
 * Whether each case also runs without the plugin: `none` runs the with-arm only, `with-without`
 * adds the no-plugin baseline to every case. Unset, it is decided per case
 */
export type PluginEvalAblation = 'none' | 'with-without';

/** The runs of a case with the plugin loaded (`with`) or with no plugin (`without`) */
export type PluginEvalArm = 'with' | 'without';

/**
 * What a `regex` grader matches or an `llm` grader judges: the final reply, the session as JSON
 * lines, the paths created during the run, the contents of one workspace file, or the calls made
 * to mocked MCP tools
 */
export type PluginEvalTarget =
  'last_message' | 'trace' | 'files' | 'mock_calls' | { source: 'file'; path: string };

/** A tool call a `tool_order` grader looks for: a tool name, or a name with an input regex */
export interface PluginEvalToolMatcher {
  tool: string;
  inputMatch?: string;
}

interface PluginEvalGraderBase {
  /** The file name without `.md`, or the `name` of a `case.yaml` entry */
  name: string;
  /** Relative weight in the run's score, any positive number */
  weight: number;
  /**
   * `with-only` keeps the grader out of the score of a two-arm run, `both` scores it in both arms
   * even when it would be excluded
   */
  arm?: 'with-only' | 'both';
}

export interface PluginEvalRegexGrader extends PluginEvalGraderBase {
  type: 'regex';
  pattern: string;
  flags: string;
  /** `contains`, `not_contains` or `count:N` for exactly N matches */
  match: string;
  target: PluginEvalTarget;
}

export interface PluginEvalToolUsedGrader extends PluginEvalGraderBase {
  type: 'tool_used';
  /** Claude Code's name of the tool (`Read`, `Skill`, `mcp__plugin_p_s__t`) or Cogitator's own */
  tool: string;
  inputMatch?: string;
  min: number;
  max?: number;
}

export interface PluginEvalToolOrderGrader extends PluginEvalGraderBase {
  type: 'tool_order';
  before: PluginEvalToolMatcher;
  after: PluginEvalToolMatcher;
}

export interface PluginEvalFileExistsGrader extends PluginEvalGraderBase {
  type: 'file_exists';
  /** A glob over the paths created during the run, relative to the workspace */
  path: string;
  exists: boolean;
}

export interface PluginEvalLlmGrader extends PluginEvalGraderBase {
  type: 'llm';
  criteria: string;
  focus: PluginEvalTarget;
}

export interface PluginEvalBaselineGrader extends PluginEvalGraderBase {
  type: 'baseline';
  /** The reference transcript, a `.jsonl` file of the case directory */
  baselineFile: string;
  criteria: string;
}

/** One check applied after a run, in the format of Claude Code's plugin eval graders */
export type PluginEvalGrader =
  | PluginEvalRegexGrader
  | PluginEvalToolUsedGrader
  | PluginEvalToolOrderGrader
  | PluginEvalFileExistsGrader
  | PluginEvalLlmGrader
  | PluginEvalBaselineGrader;

/** The type of an `expect:` check of a mocked tool's input */
export type PluginEvalExpectType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

/** How one input field of a mocked tool call is checked */
export type PluginEvalExpectation =
  | { kind: 'type'; type: PluginEvalExpectType }
  | { kind: 'pattern'; source: string; flags: string }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'oneOf'; values: readonly (string | number | boolean | null)[] };

/** A mocked MCP tool: `mocks/<server>/<tool>.md` */
export interface PluginEvalMockTool {
  server: string;
  tool: string;
  /** The tool result, with `{{input.<field>}}` and `{{file:fixtures/...}}` substitutions */
  body: string;
  /** Return the body as a tool error */
  error: boolean;
  /** Checks of the call's input by dotted path, a violation aborts the run */
  expect: Readonly<Record<string, PluginEvalExpectation>>;
  /** The server's mock directory, where `fixtures/` lives */
  dir: string;
  description?: string;
  /** The input JSON Schema from the server's `_tools.json` */
  inputSchema?: Readonly<Record<string, unknown>>;
}

/** A case as it was loaded: its prompt, its run settings and its graders */
export interface PluginEvalCase {
  name: string;
  /** The case directory */
  dir: string;
  /** The case directory relative to the eval directory */
  path: string;
  description?: string;
  expectedOutcome?: string;
  tags: string[];
  /** Plugin directories under test, absolute */
  plugins: string[];
  runs: number;
  model?: string;
  maxTurns: number;
  timeoutSeconds: number;
  allowedTools: string[];
  appendSystemPrompt?: string;
  env: Record<string, string>;
  prompt: string;
  context: {
    /** The scaffold script, absolute */
    scaffoldScript?: string;
    /** The transcript to resume, absolute */
    historyFile?: string;
    /** Read-only fixture directories, relative to the case directory */
    addDirs: string[];
  };
  graders: PluginEvalGrader[];
  /** Mocked tools by server, the case's own over the suite's */
  mocks: Record<string, PluginEvalMockTool[]>;
  /**
   * Why a suite mock server cannot be used, by server: it fails the case only when the case uses
   * the server, that is when one of its plugins declares it
   */
  mockProblems: Record<string, string>;
}

/** A judge's vote on an `llm` or `baseline` grader */
export interface PluginEvalVote {
  verdict: 'PASS' | 'FAIL' | 'ERROR';
  reasoning?: string;
}

export interface PluginEvalGraderResult {
  name: string;
  type: PluginEvalGrader['type'];
  passed: boolean;
  /** Whether the grader counts toward the run's score: false for plugin-fired indicators */
  scored: boolean;
  weight: number;
  explanation: string;
  /** The judge's votes, for `llm` and `baseline` graders */
  votes?: PluginEvalVote[];
  /** What the judge was shown */
  evidence?: string;
  /** The cost ceiling skipped this judge grader */
  skipped?: boolean;
  costUsd?: number;
}

/** A tool call of a run, under Claude Code's name and input shape */
export interface PluginEvalToolCall {
  id: string;
  /** Claude Code's name, such as `Read`, `Skill` or `mcp__plugin_p_s__t` */
  name: string;
  /** The Cogitator tool that ran */
  tool: string;
  input: Record<string, unknown>;
}

/** A call to a mocked MCP tool */
export interface PluginEvalMockCall {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  error: boolean;
}

/** Why a mock stopped a run */
export interface PluginEvalAbort {
  server: string;
  tool: string;
  reason: string;
}

export interface PluginEvalRunResult {
  arm: PluginEvalArm;
  /** The run's number within its arm, from 1 */
  index: number;
  /** Weighted fraction of the scored graders that passed */
  score: number;
  /** `null`, or why the run ended abnormally */
  error: string | null;
  /** The run ended on a model provider error and scored 0 without grading */
  apiError?: boolean;
  /** A mock stopped the run: it scores 0 and `error` stays `null` */
  aborted?: PluginEvalAbort;
  /** The cost ceiling skipped this run's judge graders, so its score is not comparable */
  skippedPaidGraders?: boolean;
  graders: PluginEvalGraderResult[];
  lastMessage: string;
  toolCalls: PluginEvalToolCall[];
  mockCalls: PluginEvalMockCall[];
  /** Paths created during the run, relative to the workspace */
  filesCreated: string[];
  /** List-price estimate of the run's model calls and its judge calls */
  costUsd: number;
  durationSeconds: number;
  /** The run's temporary directory, kept with `keepTemp` */
  tempDir?: string;
}

export interface PluginEvalCaseAggregates {
  /** Mean with-arm run score, `null` when no with-arm run happened */
  score: number | null;
  /** Mean without-arm run score, absent for a single-arm case */
  withoutScore?: number | null;
  /** With-arm score minus without-arm score, absent when the arms are not comparable */
  delta?: number;
  passed: boolean;
  runs: number;
  costUsd: number;
}

export interface PluginEvalCaseResult {
  name: string;
  /** The case directory relative to the eval directory */
  path: string;
  tags: string[];
  /** Why the case did not load: it scores 0 and does not run */
  error?: string;
  /** The case ran its with-arm only */
  singleArm: boolean;
  notices: string[];
  prompt: string;
  graders: PluginEvalGrader[];
  arms: { with: PluginEvalRunResult[]; without: PluginEvalRunResult[] };
  aggregates: PluginEvalCaseAggregates;
}

/** Why a run did not finish every case */
export type PluginEvalPartialReason = 'cost_ceiling' | 'interrupted' | 'auth_failed';

/** How the run ended, which the CLI turns into its exit code */
export type PluginEvalOutcome = 'passed' | 'failed' | 'partial' | 'interrupted';

/**
 * The result document of a plugin eval run, `aggregate-result.json`: versioned, camelCase, new
 * fields added without renaming the ones there
 */
export interface PluginEvalResult {
  schemaVersion: 1;
  /** The version of `@cogitator-ai/core` that ran the suite */
  cogitatorVersion: string;
  plugin: { name: string; root: string; version?: string };
  evalDir: string;
  startedAt: string;
  outcome: PluginEvalOutcome;
  partial: boolean;
  partialReason: PluginEvalPartialReason | null;
  config: {
    runs?: number;
    concurrency: number;
    model?: string;
    judgeModel?: string;
    ablation?: PluginEvalAblation;
    threshold: number;
    maxCostUsd?: number;
    allowTools: string[];
    scaffold: boolean;
    caseFilter?: string;
    tagFilter: string[];
  };
  aggregates: {
    /** Mean case score across the suite */
    overallScore: number;
    casesPassed: number;
    casesTotal: number;
    /** Mean delta across the cases that have one */
    meanDelta?: number;
    /** Mean without-arm score across the cases that have one */
    baselineScore?: number;
    /** Share of with-arm runs where every grader passed */
    perfectRuns: number;
  };
  /** Runs that ended on a model provider error, which fail the command whatever the scores */
  apiErrors: number;
  /** Cases that failed to load */
  loadErrors: number;
  warnings: string[];
  cases: PluginEvalCaseResult[];
  costUsd: number;
  durationSeconds: number;
}

/** What a plugin eval run reports while it works */
export type PluginEvalProgressEvent =
  | { type: 'warning'; message: string }
  | { type: 'case'; case: string; notices: readonly string[]; arms: readonly PluginEvalArm[] }
  | { type: 'run'; case: string; run: PluginEvalRunResult; of: number }
  | { type: 'skipped'; case: string; reason: PluginEvalPartialReason };

export interface PluginEvalOptions {
  /**
   * A plugin directory, a `prompt.md` or `case.yaml` file, or an installed plugin as `name` or
   * `name@marketplace` (default: the working directory)
   */
  target?: string;
  /** The directory a relative target and a named plugin's results start from (default `process.cwd()`) */
  cwd?: string;
  /** The LLM configuration of the runs and the judge: providers, keys, backends, default model */
  llm: CogitatorConfig['llm'];
  /** Model of the agent under test, over each case's `model` and `llm.defaultModel` */
  model?: string;
  /** Model of `llm` and `baseline` graders (default: each case's agent model) */
  judgeModel?: string;
  /** Runs per case per arm, 1 to 50, over each case's `runs` */
  runs?: number;
  /** Agent runs at once, 1 to 8 (default 1) */
  concurrency?: number;
  ablation?: PluginEvalAblation;
  /** A case passes when its with-arm score is at least this, 0 to 1 (default 1) */
  threshold?: number;
  /** Ceiling on the list-price cost estimate: once spent, no further run starts */
  maxCostUsd?: number;
  /** Tools granted beyond the read-only set, as permission rules: `Write`, `Bash(npm test *)` */
  allowTools?: readonly string[];
  /** Run each case's `context.scaffold_script` */
  scaffold?: boolean;
  /** A glob the case names must match */
  caseGlob?: string;
  /** Keep the cases with any of these tags */
  tags?: readonly string[];
  /** The eval directory below the plugin, relative and of plain directory names */
  evalDir?: string;
  /** Where `aggregate-result.json` and `report.html` go (default `<evalDir>/results/<timestamp>/`) */
  outputDir?: string;
  /** Keep every run's temporary directory */
  keepTemp?: boolean;
  /**
   * How granted `Bash` commands are spawned in a run's workspace, such as a `launch` that wraps
   * them in an OS sandbox. Commands otherwise run as this process, confined to the workspace
   * directory only
   */
  exec?: Omit<LocalWorkspaceExecConfig, 'env'>;
  /** Where installed plugins are kept, for a named target (default `defaultPluginsRoot()`) */
  pluginsRoot?: string;
  /** Stops starting runs and aborts the running ones: the result is partial, `interrupted` */
  signal?: AbortSignal;
  onProgress?: (event: PluginEvalProgressEvent) => void;
}

/** What `experimental_runPluginEvals` returns: the result document and where it was written */
export interface PluginEvalReport {
  result: PluginEvalResult;
  /** The directory of `aggregate-result.json` and `report.html` */
  outputDir: string;
  resultFile: string;
  reportFile: string;
}
