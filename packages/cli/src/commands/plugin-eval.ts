import { Command, type CommanderError } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  experimental_runPluginEvals,
  PluginEvalError,
  type PluginEvalCaseResult,
  type PluginEvalOptions,
  type PluginEvalProgressEvent,
  type PluginEvalReport,
  type PluginEvalResult,
  type PluginEvalRunResult,
} from '@cogitator-ai/evals';
import { CommandError, examplesHelp, reportFailure } from '../utils/cli.js';
import { findConfig, loadRunConfig } from '../utils/run-config.js';

/** Exit codes of `cogitator plugin eval`, as Claude Code's `claude plugin eval` uses them */
export const PLUGIN_EVAL_EXIT = {
  passed: 0,
  failed: 1,
  partial: 2,
  interrupted: 130,
  terminated: 143,
} as const;

export interface PluginEvalFlags {
  runs?: string;
  concurrency?: string;
  model?: string;
  judgeModel?: string;
  ablation?: string;
  threshold?: string;
  maxCostUsd?: string;
  allowTools?: string[];
  scaffold?: boolean;
  case?: string;
  tag?: string[];
  evalDir?: string;
  json?: boolean | string;
  outputDir?: string;
  keepTemp?: boolean;
  verbose?: boolean;
  config?: string;
  /** Accepted for Claude Code's command lines: there is no trust prompt */
  trustPlugin?: boolean;
  /** `--no-publish` sets it false. Accepted for Claude Code's command lines: the report stays local */
  publish?: boolean;
  /** Accepted for Claude Code's command lines: the report stays local */
  publishReport?: boolean;
  /** `record` only: mocked MCP tools answer from their files */
  mocks?: string;
  allowRealServers?: boolean;
}

/** What `runPluginEval` runs the suite with, replaceable in tests */
export interface PluginEvalDependencies {
  run: (options: PluginEvalOptions) => Promise<PluginEvalReport>;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_DEPENDENCIES: PluginEvalDependencies = {
  run: experimental_runPluginEvals,
  env: process.env,
};

function integer(
  value: string | undefined,
  flag: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CommandError(`${flag} takes a whole number from ${min} to ${max}, got ${value}`);
  }
  return parsed;
}

function decimal(
  value: string | undefined,
  flag: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    const range = max === Infinity ? `${min} or more` : `from ${min} to ${max}`;
    throw new CommandError(`${flag} takes a number ${range}, got ${value}`);
  }
  return parsed;
}

function ablationOf(value: string | undefined): PluginEvalOptions['ablation'] {
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'with-without') return value;
  throw new CommandError(`--ablation takes none or with-without, got ${value}`);
}

/** The options of the suite run: the flags, and the LLM configuration of the project and env */
export function pluginEvalOptions(
  target: string | undefined,
  flags: PluginEvalFlags,
  env: NodeJS.ProcessEnv
): PluginEvalOptions {
  const realServers =
    "real plugin MCP servers are not started by Cogitator's plugin evals: mock their tools under mocks/<server>/<tool>.md";
  if (flags.mocks !== undefined && flags.mocks !== 'record') {
    throw new CommandError(
      flags.mocks === 'off'
        ? `--mocks off is not supported, ${realServers}`
        : `--mocks takes record, got ${flags.mocks}`
    );
  }
  if (flags.allowRealServers) {
    throw new CommandError(`--allow-real-servers is not supported, ${realServers}`);
  }
  if (typeof flags.json === 'string' && !flags.json.endsWith('.json')) {
    throw new CommandError(`--json output path must end in .json, got ${flags.json}`, {
      hints: ['Put the target before --json, as in: cogitator plugin eval . --json'],
    });
  }
  const configPath = findConfig(flags.config, env);
  if (flags.config && !configPath) {
    throw new CommandError(`Config file not found: ${resolve(flags.config)}`);
  }
  let loaded: ReturnType<typeof loadRunConfig>;
  try {
    loaded = loadRunConfig(configPath);
  } catch (error) {
    throw new CommandError(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const llm = loaded.config.llm ?? {};
  const defaultModel = env.COGITATOR_MODEL || llm.defaultModel || loaded.model;
  const runs = integer(flags.runs, '--runs', 1, 50);
  const concurrency = integer(flags.concurrency, '--concurrency', 1, 8);
  const threshold = decimal(flags.threshold, '--threshold', 0, 1);
  const maxCostUsd = decimal(flags.maxCostUsd, '--max-cost-usd', 0, Infinity);
  const ablation = ablationOf(flags.ablation);
  return {
    ...(target !== undefined && { target }),
    llm: { ...llm, ...(defaultModel && { defaultModel }) },
    ...(flags.model !== undefined && { model: flags.model }),
    ...(flags.judgeModel !== undefined && { judgeModel: flags.judgeModel }),
    ...(runs !== undefined && { runs }),
    ...(concurrency !== undefined && { concurrency }),
    ...(ablation !== undefined && { ablation }),
    ...(threshold !== undefined && { threshold }),
    ...(maxCostUsd !== undefined && { maxCostUsd }),
    ...(flags.allowTools !== undefined && { allowTools: flags.allowTools }),
    ...(flags.scaffold && { scaffold: true }),
    ...(flags.case !== undefined && { caseGlob: flags.case }),
    ...(flags.tag !== undefined && { tags: flags.tag }),
    ...(flags.evalDir !== undefined && { evalDir: flags.evalDir }),
    ...(flags.outputDir !== undefined && { outputDir: flags.outputDir }),
    ...(flags.keepTemp && { keepTemp: true }),
  };
}

function score(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toFixed(2);
}

function delta(value: number | undefined): string {
  if (value === undefined) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

/** The highest-weight failing grader's explanation, or the run's error, from the with-arm */
export function caseNote(result: PluginEvalCaseResult): string {
  if (result.error !== undefined) return result.error;
  const failing = result.arms.with
    .flatMap((run) => run.graders.filter((grader) => grader.scored && !grader.passed))
    .sort((a, b) => b.weight - a.weight)[0];
  if (failing) return `${failing.name}: ${failing.explanation}`;
  const errored = result.arms.with.find((run) => run.error !== null || run.aborted);
  if (errored?.aborted)
    return `aborted by ${errored.aborted.server}/${errored.aborted.tool}: ${errored.aborted.reason}`;
  return errored?.error ?? '';
}

function table(rows: string[][]): string[] {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .trimEnd()
  );
}

/** The summary table: `CASE WITH W/OUT Δ RUNS COST NOTES`, or `SCORE PASS%` when no case has a baseline */
export function summaryLines(result: PluginEvalResult): string[] {
  const twoArm = result.cases.some((c) => !c.singleArm);
  const header = twoArm
    ? ['CASE', 'WITH', 'W/OUT', 'Δ', 'RUNS', 'COST', 'NOTES']
    : ['CASE', 'SCORE', 'PASS%', 'RUNS', 'COST', 'NOTES'];
  const rows = result.cases.map((c) => {
    const note = cut(caseNote(c), 70);
    const tail = [String(c.aggregates.runs), usd(c.aggregates.costUsd), note];
    if (twoArm) {
      return [
        c.name,
        score(c.aggregates.score),
        score(c.aggregates.withoutScore),
        delta(c.aggregates.delta),
        ...tail,
      ];
    }
    const runs = c.arms.with;
    const passing = runs.filter((run) => run.score >= result.config.threshold - 1e-9).length;
    const share = runs.length === 0 ? '-' : `${Math.round((passing / runs.length) * 100)}%`;
    return [c.name, score(c.aggregates.score), share, ...tail];
  });
  const totals = [
    `${result.cases.length} case(s)`,
    ...(result.aggregates.meanDelta !== undefined
      ? [`mean Δ ${delta(result.aggregates.meanDelta)}`]
      : []),
    `${Math.round(result.durationSeconds)}s`,
    usd(result.costUsd),
  ].join(' · ');
  return [...table([header, ...rows]), '', totals];
}

function runLine(
  caseName: string,
  run: PluginEvalRunResult,
  of: number,
  verbose: boolean
): string[] {
  const arm = run.arm === 'with' ? 'with' : 'w/out';
  const verdicts = run.graders
    .map((grader) => {
      const mark = grader.skipped
        ? chalk.dim('-')
        : grader.passed
          ? chalk.green('✓')
          : chalk.red('✗');
      return `${mark}${grader.scored ? grader.name : chalk.dim(grader.name)}`;
    })
    .join(' ');
  const problem = run.aborted
    ? chalk.red(` aborted: ${run.aborted.reason}`)
    : run.error !== null
      ? chalk.red(` error: ${run.error}`)
      : '';
  const lines = [
    `  ${caseName} ${arm} ${run.index}/${of}  ${run.score.toFixed(2)}  ${usd(run.costUsd)}  ${run.durationSeconds.toFixed(1)}s  ${verdicts}${problem}`,
  ];
  if (run.tempDir) lines.push(chalk.dim(`    kept: ${run.tempDir}`));
  if (verbose) {
    for (const grader of run.graders)
      lines.push(chalk.dim(`    ${grader.name}: ${grader.explanation}`));
  }
  return lines;
}

function progress(verbose: boolean): (event: PluginEvalProgressEvent) => void {
  let skipped = false;
  return (event) => {
    switch (event.type) {
      case 'warning':
        console.error(chalk.yellow(event.message));
        return;
      case 'case':
        console.log(chalk.bold(`${event.case}`) + chalk.dim(`  ${event.arms.join(' + ')}`));
        for (const notice of event.notices) console.log(chalk.dim(`  ${notice}`));
        return;
      case 'run':
        for (const line of runLine(event.case, event.run, event.of, verbose)) console.log(line);
        return;
      case 'skipped':
        if (!skipped) {
          skipped = true;
          const why =
            event.reason === 'cost_ceiling'
              ? 'the --max-cost-usd ceiling was reached'
              : event.reason === 'auth_failed'
                ? 'the model provider rejected the credentials'
                : 'the run was interrupted';
          console.log(chalk.yellow(`Remaining runs not started: ${why}`));
        }
        return;
    }
  };
}

function exitCodeOf(result: PluginEvalResult): number {
  return PLUGIN_EVAL_EXIT[result.outcome];
}

/** Why the command fails although every case met the threshold, for stderr */
function hiddenCauses(result: PluginEvalResult): string[] {
  const causes: string[] = [];
  if (result.loadErrors > 0) causes.push(`${result.loadErrors} case(s) failed to load`);
  if (result.apiErrors > 0) {
    causes.push(`${result.apiErrors} run(s) ended on an API error and scored 0 without grading`);
  }
  return causes;
}

/** Runs a plugin's eval suite and resolves with the exit code */
export async function runPluginEval(
  target: string | undefined,
  flags: PluginEvalFlags,
  dependencies: PluginEvalDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  const quiet = flags.json !== undefined && flags.json !== false;
  const options = pluginEvalOptions(target, flags, dependencies.env);
  const controller = new AbortController();
  let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => {
    terminated = true;
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  let report: PluginEvalReport;
  try {
    report = await dependencies.run({
      ...options,
      signal: controller.signal,
      ...(!quiet && { onProgress: progress(flags.verbose === true) }),
    });
  } catch (error) {
    if (error instanceof PluginEvalError) throw new CommandError(error.message, { cause: error });
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
  const { result } = report;
  for (const cause of hiddenCauses(result)) console.error(chalk.red(cause));
  if (result.partial) {
    console.error(chalk.yellow(`Partial results (${result.partialReason ?? 'unknown'})`));
  }
  if (typeof flags.json === 'string') {
    writeFileSync(resolve(flags.json), `${JSON.stringify(result, null, 2)}\n`);
  } else if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    for (const line of summaryLines(result)) console.log(line);
    console.log(`Report: ${report.reportFile}`);
  }
  return terminated ? PLUGIN_EVAL_EXIT.terminated : exitCodeOf(result);
}

/**
 * A command whose command-line errors (an unknown option, a missing or wrong value) exit 1 as
 * `CommandError`s: exit 2 means a partial run for `claude plugin eval`, so it is never a usage error
 * here. Commander's own message is not printed, the entry point reports the error once
 */
class PluginEvalCommand extends Command {
  override exitOverride(callback?: (error: CommanderError) => void): this {
    return super.exitOverride((error) => {
      if (error.exitCode === 0) {
        if (callback) return callback(error);
        throw error;
      }
      throw new CommandError(error.message.replace(/^error: /, ''), { cause: error });
    });
  }
}

/** `eval`: runs the eval cases of a plugin, mounted under `cogitator plugin` */
export const pluginEvalCommand = new PluginEvalCommand('eval')
  .description(
    "Run a plugin's eval cases (Claude Code's plugin eval format) with and without the plugin, and score them"
  )
  .argument(
    '[target]',
    'a plugin directory, a prompt.md or case.yaml file, or an installed plugin as name or name@marketplace (default: .)'
  )
  .option('--runs <n>', "runs per case in each arm, 1 to 50 (default: each case's runs, else 3)")
  .option('-j, --concurrency <n>', 'agent runs at once, 1 to 8 (default: 1)')
  .option(
    '--model <model>',
    "model of the agent under test (default: each case's model, else the configured one)"
  )
  .option('--judge-model <model>', 'model of llm and baseline graders (default: the agent model)')
  .option(
    '--ablation <mode>',
    'none runs the plugin arm only, with-without adds the no-plugin baseline'
  )
  .option(
    '--threshold <0..1>',
    'a case passes when its with-plugin score is at least this (default: 1.0)'
  )
  .option('--max-cost-usd <usd>', 'stop starting runs once the cost estimate reaches this, exit 2')
  .option(
    '--allow-tools <tools...>',
    'grant tools beyond the read-only set: Write, Edit, "Bash(npm test *)"'
  )
  .option('--scaffold', "run each case's context.scaffold_script")
  .option('--case <glob>', 'only the cases whose name matches the glob')
  .option('--tag <tags...>', 'only the cases with any of these tags')
  .option(
    '--eval-dir <dir>',
    "the plugin's eval directory (default: plugin.json experimental.evals, else evals)"
  )
  .option(
    '--json [path]',
    'print the result document, or write it to a .json path, without progress'
  )
  .option(
    '--output-dir <dir>',
    'where aggregate-result.json and report.html go (default: <eval dir>/results/<timestamp>)'
  )
  .option('--keep-temp', "keep every run's temporary directory and print its path")
  .option('--verbose', "print every grader's explanation")
  .option('-c, --config <path>', 'config file with the LLM providers (default: cogitator.yml)')
  .option('--trust-plugin', 'accepted for Claude Code command lines, there is no trust prompt')
  .option('--no-publish', 'accepted for Claude Code command lines, the report always stays local')
  .option(
    '--publish-report',
    'accepted for Claude Code command lines, the report always stays local'
  )
  .option(
    '--mocks <mode>',
    'record (the only mode): mocked MCP tools answer from their files',
    'record'
  )
  .option(
    '--allow-real-servers',
    'not supported: real plugin MCP servers are not started, the command exits 1'
  )
  .configureOutput({ outputError: () => undefined })
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator plugin eval .', 'every case of the plugin here, with and without it'],
      ['cogitator plugin eval . --case greets --runs 1 --ablation none', 'iterate on one case'],
      ['cogitator plugin eval . --json results.json --threshold 0.8 --max-cost-usd 20', 'for CI'],
    ])
  )
  .action(async (target: string | undefined, flags: PluginEvalFlags) => {
    let code: number;
    try {
      code = await runPluginEval(target, flags);
    } catch (error) {
      code = reportFailure(error, { json: flags.json !== undefined && flags.json !== false });
    }
    process.exit(code);
  });
