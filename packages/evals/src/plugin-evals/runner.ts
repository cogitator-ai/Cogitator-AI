import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { mean } from '../stats/percentiles';
import { executeRun, type RunOutcome } from './execute';
import { errorText } from './files';
import { grade, isPaidGrader } from './graders';
import { createPluginEvalJudge, type PluginEvalJudge } from './judge';
import { pluginEvalHtml } from './report';
import { issuesText } from './schema';
import { loadSuite, PluginEvalError, type LoadedSuite } from './suite';
import { caseGrants, parseGrant, type ToolGrant } from './tools';
import type {
  PluginEvalArm,
  PluginEvalCase,
  PluginEvalCaseResult,
  PluginEvalGrader,
  PluginEvalGraderResult,
  PluginEvalOptions,
  PluginEvalOutcome,
  PluginEvalPartialReason,
  PluginEvalReport,
  PluginEvalResult,
  PluginEvalRunResult,
} from './types';

type Core = typeof import('@cogitator-ai/core');

const OptionsSchema = z.object({
  target: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  judgeModel: z.string().trim().min(1).optional(),
  runs: z.number().int().min(1).max(50).optional(),
  concurrency: z.number().int().min(1).max(8).default(1),
  ablation: z.enum(['none', 'with-without']).optional(),
  threshold: z.number().min(0).max(1).default(1),
  maxCostUsd: z.number().min(0).optional(),
  allowTools: z.array(z.string().min(1)).default([]),
  scaffold: z.boolean().default(false),
  caseGlob: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  evalDir: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  keepTemp: z.boolean().default(false),
  pluginsRoot: z.string().min(1).optional(),
});

async function importCore(): Promise<Core> {
  try {
    return await import('@cogitator-ai/core');
  } catch (error) {
    throw new PluginEvalError(`Plugin evals need @cogitator-ai/core: ${errorText(error)}`);
  }
}

function coreVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@cogitator-ai/core');
    const json: unknown = JSON.parse(
      readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')
    );
    return typeof json === 'object' &&
      json !== null &&
      'version' in json &&
      typeof json.version === 'string'
      ? json.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function installedPlugin(
  core: Core,
  root: string | undefined,
  id: string
): Promise<string | undefined> {
  const { records, warnings } = await core.readInstalledPlugins(root ?? core.defaultPluginsRoot());
  const matches = records.filter(
    (record) => record.id === id || (!id.includes('@') && record.name === id)
  );
  if (matches.length > 1) {
    throw new PluginEvalError(
      `${id} names ${matches.length} installed plugins (${matches.map((m) => m.id).join(', ')}): give name@marketplace`
    );
  }
  if (matches.length === 0 && warnings.length > 0) {
    throw new PluginEvalError(`No installed plugin ${id} could be read: ${warnings.join(', ')}`);
  }
  return matches[0]?.installPath;
}

interface PluginFacts {
  name: string;
  version?: string;
  servers: Set<string>;
}

/** The manifest name and MCP servers of each plugin directory the cases load */
async function pluginFacts(core: Core, suite: LoadedSuite): Promise<Map<string, PluginFacts>> {
  const dirs = new Set([suite.pluginRoot]);
  for (const entry of suite.cases) for (const dir of entry.case?.plugins ?? []) dirs.add(dir);
  const facts = new Map<string, PluginFacts>();
  for (const dir of dirs) {
    const layout = await core.readPluginLayout(dir);
    if (layout.fatal.length > 0) {
      throw new PluginEvalError(`The plugin at ${dir} cannot load: ${layout.fatal.join(', ')}`);
    }
    facts.set(dir, {
      name: layout.manifest.name,
      ...(layout.manifest.version !== undefined && { version: layout.manifest.version }),
      servers: new Set(Object.keys(layout.mcpServers)),
    });
  }
  return facts;
}

/** Loads each plugin once the way a run does, so a plugin that fails fails the command up front */
async function checkPluginsLoad(
  core: Core,
  llm: PluginEvalOptions['llm'],
  dirs: readonly string[]
): Promise<void> {
  const probe = new core.Cogitator({
    llm,
    experimental_plugins: { dirs, installed: false, settings: false },
  });
  try {
    await probe.experimental_plugins.load();
    for (const info of probe.experimental_plugins.list()) {
      if (info.origin === 'core') continue;
      if (info.status !== 'active') {
        throw new PluginEvalError(
          `The plugin ${info.name} did not load: ${info.error ?? info.status}`
        );
      }
    }
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** The graders a two-arm run keeps out of the score: plugin-fired indicators */
function excludedGraders(
  evalCase: PluginEvalCase,
  twoArm: boolean,
  declared: (server: string) => boolean
): Set<string> {
  if (!twoArm) return new Set();
  const servers = Object.keys(evalCase.mocks);
  const pluginMocksOnly = servers.length > 0 && servers.every(declared);
  const indicator = (grader: PluginEvalGrader) => {
    if (grader.arm === 'both') return false;
    if (grader.arm === 'with-only') return true;
    if (grader.type === 'tool_used') {
      return grader.tool === 'Skill' || grader.tool === 'use_skill';
    }
    if (!pluginMocksOnly) return false;
    if (grader.type === 'regex') return grader.target === 'mock_calls';
    if (grader.type === 'llm') return grader.focus === 'mock_calls';
    return false;
  };
  const excluded = evalCase.graders.filter(indicator);
  if (excluded.length === evalCase.graders.length) return new Set();
  return new Set(excluded.map((grader) => grader.name));
}

/** A case ready to run: its arms, grants and what it is told about */
interface PlannedCase {
  index: number;
  case: PluginEvalCase;
  arms: PluginEvalArm[];
  grants: ToolGrant[];
  excluded: Set<string>;
  runs: number;
  model: string;
  pluginServers: Map<string, Set<string>>;
  notices: string[];
}

interface Job {
  plan: PlannedCase;
  arm: PluginEvalArm;
  index: number;
}

function weightedScore(results: readonly PluginEvalGraderResult[]): number {
  const scored = results.filter((result) => result.scored);
  const total = scored.reduce((sum, result) => sum + result.weight, 0);
  if (total === 0) return 0;
  return scored.reduce((sum, result) => sum + (result.passed ? result.weight : 0), 0) / total;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Experimental. Runs a plugin's eval suite in the format of Claude Code's `claude plugin eval`:
 * each case's prompt several times in a fresh workspace with the plugin loaded and, for the
 * no-plugin baseline, without it, scores every run with the case's graders (`regex`,
 * `tool_used`, `tool_order`, `file_exists`, and `llm` and `baseline` judged by a majority of three
 * votes) and writes `aggregate-result.json` and a self-contained `report.html`.
 *
 * Needs `@cogitator-ai/core`. Throws `PluginEvalError` when the suite cannot start: no plugin, no
 * case, an invalid option. A case that fails to load is reported in the result instead.
 *
 * @example
 * ```ts
 * const { result, reportFile } = await experimental_runPluginEvals({
 *   target: './my-plugin',
 *   llm: { defaultModel: 'anthropic/claude-sonnet-5-5' },
 *   threshold: 0.8,
 * });
 * console.log(result.aggregates.overallScore, reportFile);
 * ```
 */
export async function experimental_runPluginEvals(
  input: PluginEvalOptions
): Promise<PluginEvalReport> {
  const parsed = OptionsSchema.safeParse(input);
  if (!parsed.success) throw new PluginEvalError(`Invalid options: ${issuesText(parsed.error)}`);
  const options = parsed.data;
  const started = new Date();
  const cwd = resolve(options.cwd ?? process.cwd());
  const signal = input.signal ?? new AbortController().signal;
  const emit = input.onProgress ?? (() => undefined);

  const runGrants: ToolGrant[] = [];
  for (const rule of options.allowTools) {
    const grant = parseGrant(rule);
    if ('error' in grant) throw new PluginEvalError(`--allow-tools: ${grant.error}`);
    runGrants.push(grant);
  }

  const core = await importCore();
  const suite = await loadSuite({
    ...(options.target !== undefined && { target: options.target }),
    cwd,
    ...(options.evalDir !== undefined && { evalDir: options.evalDir }),
    ...(options.caseGlob !== undefined && { caseGlob: options.caseGlob }),
    tags: options.tags,
    installed: (id) => installedPlugin(core, options.pluginsRoot, id),
  });
  for (const warning of suite.warnings) emit({ type: 'warning', message: warning });
  const facts = await pluginFacts(core, suite);
  await checkPluginsLoad(core, input.llm, [...facts.keys()]);
  const main = facts.get(suite.pluginRoot);
  if (!main) throw new PluginEvalError(`No plugin found at ${suite.pluginRoot}`);

  const results: PluginEvalCaseResult[] = [];
  const plans: PlannedCase[] = [];
  for (const entry of suite.cases) {
    const evalCase = entry.case;
    if (!evalCase || entry.error !== undefined) {
      results.push({
        name: entry.name,
        path: entry.path,
        tags: evalCase?.tags ?? [],
        error: entry.error ?? 'the case did not load',
        singleArm: true,
        notices: [],
        prompt: evalCase?.prompt ?? '',
        graders: evalCase?.graders ?? [],
        arms: { with: [], without: [] },
        aggregates: { score: 0, passed: false, runs: 0, costUsd: 0 },
      });
      continue;
    }
    const notices: string[] = [];
    const granted = caseGrants(evalCase.allowedTools, runGrants);
    const pluginServers = new Map<string, Set<string>>();
    for (const dir of evalCase.plugins) {
      const plugin = facts.get(dir);
      if (plugin) pluginServers.set(plugin.name, plugin.servers);
    }
    const declared = (server: string) => [...pluginServers.values()].some((set) => set.has(server));
    const model = options.model ?? evalCase.model ?? input.llm?.defaultModel;
    const caseResult: PluginEvalCaseResult = {
      name: evalCase.name,
      path: evalCase.path,
      tags: evalCase.tags,
      singleArm: true,
      notices,
      prompt: evalCase.prompt,
      graders: evalCase.graders,
      arms: { with: [], without: [] },
      aggregates: { score: null, passed: false, runs: 0, costUsd: 0 },
    };
    results.push(caseResult);
    if ('error' in granted) {
      caseResult.error = granted.error;
      caseResult.aggregates.score = 0;
      continue;
    }
    const usedProblems = Object.entries(evalCase.mockProblems).filter(([server]) =>
      declared(server)
    );
    if (usedProblems.length > 0) {
      caseResult.error = `invalid mock: ${usedProblems.map(([, problem]) => problem).join(', ')}`;
      caseResult.aggregates.score = 0;
      continue;
    }
    for (const [server, problem] of Object.entries(evalCase.mockProblems)) {
      if (!declared(server)) notices.push(`mocks/${server} left out: ${problem}`);
    }
    if (model === undefined) {
      throw new PluginEvalError(
        'No model for the agent under test: pass --model, set model in the case, or llm.defaultModel in the configuration'
      );
    }
    const singleArm =
      options.ablation === 'none' ||
      (options.ablation === undefined &&
        evalCase.context.historyFile !== undefined &&
        !suite.named);
    caseResult.singleArm = singleArm;
    if (singleArm && options.ablation === undefined) {
      notices.push('single-arm (no delta): the case resumes a transcript');
    }
    if (granted.notGranted.length > 0)
      notices.push(`not granted: ${granted.notGranted.join(', ')}`);
    if (granted.noCounterpart.length > 0) {
      notices.push(`no Cogitator counterpart, not given: ${granted.noCounterpart.join(', ')}`);
    }
    if (evalCase.context.scaffoldScript && !options.scaffold) {
      notices.push('scaffold_script not run: pass --scaffold to run it');
    }
    const mocked: string[] = [];
    for (const [plugin, servers] of pluginServers) {
      for (const server of [...servers].sort()) {
        const tools = evalCase.mocks[server];
        mocked.push(
          `plugin_${plugin}_${server}[${tools ? tools.map((tool) => tool.tool).join(', ') : 'not started: no mock'}]`
        );
      }
    }
    for (const [server, tools] of Object.entries(evalCase.mocks)) {
      if (!declared(server)) mocked.push(`${server}[${tools.map((tool) => tool.tool).join(', ')}]`);
    }
    if (mocked.length > 0) notices.push(`mocked: ${mocked.join(', ')}`);
    plans.push({
      index: results.length - 1,
      case: evalCase,
      arms: singleArm ? ['with'] : ['with', 'without'],
      grants: granted.grants,
      excluded: excludedGraders(evalCase, !singleArm, declared),
      runs: options.runs ?? evalCase.runs,
      model,
      pluginServers,
      notices,
    });
  }

  const needsJudge = plans.some((plan) => plan.case.graders.some(isPaidGrader));
  const judgeRuntime = needsJudge ? new core.Cogitator({ llm: input.llm }) : undefined;
  const judges = new Map<string, PluginEvalJudge>();
  const judgeOf = (plan: PlannedCase): PluginEvalJudge | undefined => {
    if (!judgeRuntime) return undefined;
    const model = options.judgeModel ?? plan.model;
    let judge = judges.get(model);
    if (!judge) {
      judge = createPluginEvalJudge(judgeRuntime, model);
      judges.set(model, judge);
    }
    return judge;
  };

  const jobs: Job[] = [];
  for (const plan of plans) {
    emit({ type: 'case', case: plan.case.name, notices: plan.notices, arms: plan.arms });
    for (const arm of plan.arms) {
      for (let index = 1; index <= plan.runs; index++) jobs.push({ plan, arm, index });
    }
  }

  let spent = 0;
  let partialReason: PluginEvalPartialReason | null = null;
  let completedCleanly = false;
  const ceilingReached = () => options.maxCostUsd !== undefined && spent >= options.maxCostUsd;
  const stopReason = (): PluginEvalPartialReason | undefined => {
    if (signal.aborted) return 'interrupted';
    if (partialReason === 'auth_failed') return 'auth_failed';
    if (ceilingReached()) return 'cost_ceiling';
    return undefined;
  };

  const gradeRun = async (job: Job, outcome: RunOutcome): Promise<PluginEvalRunResult> => {
    const { plan, arm } = job;
    const graders: PluginEvalGraderResult[] = [];
    let skippedPaid = false;
    let cost = outcome.costUsd;
    if (outcome.capture) {
      for (const grader of plan.case.graders) {
        const excluded = plan.excluded.has(grader.name);
        if (excluded && arm === 'without') continue;
        const base = { name: grader.name, type: grader.type, weight: grader.weight };
        if (isPaidGrader(grader) && signal.aborted) {
          skippedPaid = true;
          partialReason ??= 'interrupted';
          graders.push({
            ...base,
            passed: false,
            scored: false,
            skipped: true,
            explanation: 'skipped: the run was interrupted before this judge grader',
          });
          continue;
        }
        const judge = isPaidGrader(grader) ? judgeOf(plan) : undefined;
        if (isPaidGrader(grader) && (ceilingReached() || !judge)) {
          skippedPaid = true;
          if (ceilingReached()) partialReason ??= 'cost_ceiling';
          graders.push({
            ...base,
            passed: false,
            scored: false,
            skipped: true,
            explanation: 'skipped: the cost ceiling was reached before this judge grader',
          });
          continue;
        }
        try {
          const verdict = await grade(grader, outcome.capture, judge ?? noJudge, signal);
          cost += verdict.costUsd ?? 0;
          spent += verdict.costUsd ?? 0;
          graders.push({ ...base, ...verdict, scored: !excluded });
        } catch (error) {
          if (isPaidGrader(grader) && signal.aborted) {
            skippedPaid = true;
            partialReason ??= 'interrupted';
            graders.push({
              ...base,
              passed: false,
              scored: false,
              skipped: true,
              explanation: 'skipped: the run was interrupted while the judge graded',
            });
            continue;
          }
          graders.push({
            ...base,
            passed: false,
            scored: !excluded,
            explanation: `grader error: ${errorText(error)}`,
          });
        }
      }
    }
    const capture = outcome.capture;
    return {
      arm,
      index: job.index,
      score: capture && !outcome.aborted ? weightedScore(graders) : 0,
      error: outcome.error,
      ...(outcome.apiError && { apiError: true }),
      ...(outcome.aborted && { aborted: outcome.aborted }),
      ...(skippedPaid && { skippedPaidGraders: true }),
      graders,
      lastMessage: capture?.lastMessage ?? '',
      toolCalls: capture?.toolCalls ?? [],
      mockCalls: capture?.mockCalls ?? [],
      filesCreated: capture?.filesCreated ?? [],
      costUsd: cost,
      durationSeconds: outcome.durationSeconds,
      ...(outcome.tempDir !== undefined && { tempDir: outcome.tempDir }),
    };
  };

  const runs = new Map<Job, PluginEvalRunResult>();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) break;
      const stop = stopReason();
      if (stop) {
        partialReason ??= stop;
        emit({ type: 'skipped', case: job.plan.case.name, reason: stop });
        continue;
      }
      const outcome = await executeRun({
        core,
        case: job.plan.case,
        arm: job.arm,
        llm: input.llm,
        model: job.plan.model,
        grants: job.plan.grants,
        pluginServers: job.plan.pluginServers,
        scaffold: options.scaffold,
        exec: input.exec,
        keepTemp: options.keepTemp,
        signal,
      });
      spent += outcome.costUsd;
      if (outcome.authFailed && !completedCleanly) partialReason ??= 'auth_failed';
      if (outcome.interrupted) {
        partialReason ??= 'interrupted';
        outcome.cleanup();
        continue;
      }
      if (!outcome.apiError) completedCleanly = true;
      try {
        const run = await gradeRun(job, outcome);
        runs.set(job, run);
        emit({ type: 'run', case: job.plan.case.name, run, of: job.plan.runs });
      } finally {
        outcome.cleanup();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  } finally {
    await judgeRuntime?.close().catch(() => undefined);
  }
  if (signal.aborted) partialReason ??= 'interrupted';

  for (const job of jobs) {
    const run = runs.get(job);
    if (!run) continue;
    const target = results[job.plan.index];
    if (target) target.arms[job.arm].push(run);
  }
  for (const plan of plans) {
    const result = results[plan.index];
    if (!result || result.error !== undefined) continue;
    const withRuns = result.arms.with;
    const withoutRuns = result.arms.without;
    const score = withRuns.length > 0 ? mean(withRuns.map((run) => run.score)) : null;
    const comparable =
      !withRuns.some((run) => run.apiError) && !withoutRuns.some((run) => run.apiError);
    const withoutScore = result.singleArm
      ? undefined
      : withoutRuns.length > 0 && !withoutRuns.some((run) => run.apiError)
        ? mean(withoutRuns.map((run) => run.score))
        : null;
    result.aggregates = {
      score,
      ...(withoutScore !== undefined && { withoutScore }),
      ...(score !== null &&
        withoutScore !== undefined &&
        withoutScore !== null &&
        comparable && { delta: score - withoutScore }),
      passed: score !== null && score >= options.threshold - 1e-9,
      runs: withRuns.length + withoutRuns.length,
      costUsd: [...withRuns, ...withoutRuns].reduce((sum, run) => sum + run.costUsd, 0),
    };
  }

  const allRuns = results.flatMap((result) => [...result.arms.with, ...result.arms.without]);
  const withRuns = results.flatMap((result) => result.arms.with);
  const deltas = results.flatMap((result) =>
    result.aggregates.delta === undefined ? [] : [result.aggregates.delta]
  );
  const baselines = results.flatMap((result) =>
    typeof result.aggregates.withoutScore === 'number' ? [result.aggregates.withoutScore] : []
  );
  const apiErrors = allRuns.filter((run) => run.apiError).length;
  const loadErrors = results.filter((result) => result.error !== undefined).length;
  const casesPassed = results.filter((result) => result.aggregates.passed).length;
  const partial = partialReason !== null;
  const outcome: PluginEvalOutcome =
    partialReason === 'interrupted'
      ? 'interrupted'
      : partial
        ? 'partial'
        : casesPassed === results.length && apiErrors === 0 && loadErrors === 0
          ? 'passed'
          : 'failed';

  const result: PluginEvalResult = {
    schemaVersion: 1,
    cogitatorVersion: coreVersion(),
    plugin: {
      name: main.name,
      root: suite.pluginRoot,
      ...(main.version !== undefined && { version: main.version }),
    },
    evalDir: suite.evalDir,
    startedAt: started.toISOString(),
    outcome,
    partial,
    partialReason,
    config: {
      ...(options.runs !== undefined && { runs: options.runs }),
      concurrency: options.concurrency,
      ...(options.model !== undefined && { model: options.model }),
      ...(options.judgeModel !== undefined && { judgeModel: options.judgeModel }),
      ...(options.ablation !== undefined && { ablation: options.ablation }),
      threshold: options.threshold,
      ...(options.maxCostUsd !== undefined && { maxCostUsd: options.maxCostUsd }),
      allowTools: options.allowTools,
      scaffold: options.scaffold,
      ...(options.caseGlob !== undefined && { caseFilter: options.caseGlob }),
      tagFilter: options.tags,
    },
    aggregates: {
      overallScore: mean(results.map((result) => result.aggregates.score ?? 0)),
      casesPassed,
      casesTotal: results.length,
      ...(deltas.length > 0 && { meanDelta: mean(deltas) }),
      ...(baselines.length > 0 && { baselineScore: mean(baselines) }),
      perfectRuns:
        withRuns.length === 0
          ? 0
          : withRuns.filter(
              (run) => run.graders.length > 0 && run.graders.every((grader) => grader.passed)
            ).length / withRuns.length,
    },
    apiErrors,
    loadErrors,
    warnings: suite.warnings,
    cases: results,
    costUsd: allRuns.reduce((sum, run) => sum + run.costUsd, 0),
    durationSeconds: (Date.now() - started.getTime()) / 1000,
  };

  const outputDir = options.outputDir
    ? resolve(cwd, options.outputDir)
    : join(suite.resultsDir, timestamp(started));
  mkdirSync(outputDir, { recursive: true });
  const resultFile = join(outputDir, 'aggregate-result.json');
  const reportFile = join(outputDir, 'report.html');
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(reportFile, pluginEvalHtml(result));
  return { result, outputDir, resultFile, reportFile };
}

const noJudge: PluginEvalJudge = {
  ask: () => Promise.reject(new Error('no judge model is configured')),
};
