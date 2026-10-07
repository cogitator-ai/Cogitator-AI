import { Command } from 'commander';
import chalk from 'chalk';
import { join, relative } from 'node:path';
import { loadConfig } from '@cogitator-ai/config';
import { loadProjectEnv } from '../utils/doctor.js';
import {
  isEvalSuite,
  missingCredential,
  outcomeOf,
  resolveEvalFiles,
  type SuiteOutcome,
} from '../utils/evals.js';
import { importUserModule } from '../utils/module-loader.js';

interface EvalFlags {
  json?: boolean;
  report?: string;
  maxCases?: string;
  skipWithoutKey?: boolean;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error('--max-cases takes a positive integer');
  return parsed;
}

/** Runs the eval suites and resolves with the exit code. */
export async function runEvals(files: readonly string[], flags: EvalFlags): Promise<number> {
  const projectDir = process.cwd();
  loadProjectEnv(projectDir);
  const print = (line: string) => {
    if (!flags.json) console.log(line);
  };

  if (flags.skipWithoutKey) {
    const missing = missingCredential(loadConfig());
    if (missing) {
      if (flags.json)
        console.log(JSON.stringify({ ok: true, skipped: true, reason: `${missing} is not set` }));
      else print(chalk.yellow(`Skipping evals: ${missing} is not set`));
      return 0;
    }
  }

  const paths = resolveEvalFiles(projectDir, files);
  if (paths.length === 0) {
    throw new Error(
      'No eval files found: add evals/<name>.eval.ts exporting an EvalSuite as default'
    );
  }

  const outcomes: SuiteOutcome[] = [];
  for (const path of paths) {
    const module = await importUserModule(path, projectDir);
    const suite = module.default;
    if (!isEvalSuite(suite)) {
      throw new Error(`${path} must export an EvalSuite as its default export`);
    }
    print(chalk.bold(`\n${relative(projectDir, path)}`));
    const result = await suite.run({ maxCases: positiveInteger(flags.maxCases) });
    if (!flags.json) result.report('console');
    if (flags.report) {
      const target =
        paths.length === 1 ? flags.report : join(flags.report, `${outcomes.length}.json`);
      result.report('json', { path: target });
    }
    outcomes.push(outcomeOf(projectDir, path, result));
  }

  const ok = outcomes.every((outcome) => outcome.passed);
  if (flags.json) {
    console.log(JSON.stringify({ ok, skipped: false, suites: outcomes }, null, 2));
  } else {
    const failed = outcomes.filter((outcome) => !outcome.passed);
    print(
      failed.length === 0
        ? chalk.green(`\n${outcomes.length} eval suite${outcomes.length === 1 ? '' : 's'} passed`)
        : chalk.red(
            `\n${failed.length} of ${outcomes.length} eval suites failed: ${failed.map((f) => f.file).join(', ')}`
          )
    );
  }
  return ok ? 0 : 1;
}

export const evalCommand = new Command('eval')
  .description(
    'Run the eval suites in evals/ (or the files given) and fail when an assertion fails'
  )
  .argument('[files...]', 'eval files or directories, default: every *.eval.ts under evals/')
  .option('--json', 'print the results as JSON')
  .option('--report <path>', 'also write a JSON report to this path')
  .option('--max-cases <n>', 'run only the first n cases of each suite')
  .option(
    '--skip-without-key',
    'exit 0 without running when the model has no API key, for CI on forks'
  )
  .action(async (files: string[], flags: EvalFlags) => {
    let code: number;
    try {
      code = await runEvals(files, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (flags.json) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(chalk.red(message));
      code = 1;
    }
    process.exit(code);
  });
