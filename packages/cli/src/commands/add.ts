import { Command } from 'commander';
import chalk from 'chalk';
import {
  addToProject,
  changesDependencies,
  FEATURES,
  installCommand,
  planAdd,
  silentLogger,
  type ScaffoldLogger,
} from 'create-cogitator-app';
import {
  addChangesFrom,
  addPlanJson,
  formatAddPlan,
  formatConflicts,
  type AddFlags,
} from '../utils/add.js';
import { examplesHelp } from '../utils/cli.js';
import { log } from '../utils/logger.js';

export interface AddCommandFlags extends AddFlags {
  dryRun?: boolean;
  json?: boolean;
  install?: boolean;
}

const consoleLogger: ScaffoldLogger = {
  start: (message) => log.step(message),
  done: (message) => log.success(message),
  fail: (message) => log.error(message),
  warn: (message) => log.warn(message),
};

/** Adds features to the project in `directory` and resolves with the exit code. */
export async function runAdd(
  directory: string,
  features: readonly string[],
  flags: AddCommandFlags
): Promise<number> {
  const changes = addChangesFrom(features, flags);
  const plan = planAdd(directory, changes);
  const refused = plan.conflicts.length > 0;

  if (flags.dryRun || refused || plan.upToDate) {
    if (flags.json) console.log(JSON.stringify(addPlanJson(plan), null, 2));
    else console.log(refused ? formatConflicts(plan) : formatAddPlan(plan, { diffs: true }));
    return refused ? 1 : 0;
  }

  const result = await addToProject(directory, changes, {
    install: flags.install !== false,
    log: flags.json ? silentLogger : consoleLogger,
  });
  if (flags.json) {
    console.log(JSON.stringify(addPlanJson(result.plan, result), null, 2));
    return result.install.status === 'failed' ? 1 : 0;
  }

  console.log(`\n${formatAddPlan(result.plan, { diffs: false })}\n`);
  const steps: string[] = [];
  if (changesDependencies(result.plan) && result.install.status !== 'done') {
    steps.push(installCommand(result.plan.to.packageManager));
  }
  for (const variable of result.plan.env.filter((entry) => entry.required)) {
    steps.push(`set ${variable.name} in .env ${chalk.dim(`(${variable.description})`)}`);
  }
  if (result.plan.services.length > 0) {
    steps.push(`docker compose up -d ${result.plan.services.join(' ')}`);
  }
  if (steps.length > 0)
    console.log([chalk.bold('Next'), ...steps.map((step) => `  ${step}`)].join('\n'));
  log.success(`Added ${result.plan.summary.join(', ')}`);
  return result.install.status === 'failed' ? 1 : 0;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export const addCommand = new Command('add')
  .description('Add features to a project created by create-cogitator-app or cogitator init')
  .argument('[features...]', `features to add: ${FEATURES.join(', ')}`)
  .option('--memory <kind>', 'switch the memory adapter: memory, sqlite, postgres, redis, mongodb')
  .option('--vector-store <store>', 'switch the RAG vector store: memory, postgres, qdrant')
  .option('--deploy <target>', 'add deployment: docker or fly')
  .option('--channel <name>', 'add a messaging channel to a bot (repeatable)', collect)
  .option('--agent <name>', 'add coding agent setup: claude, cursor, codex (repeatable)', collect)
  .option('--dry-run', 'show what would change, with diffs, without writing anything')
  .option('--json', 'print the plan or the result as JSON')
  .option('--no-install', 'do not install when the dependencies change')
  .addHelpText(
    'after',
    [
      examplesHelp([
        ['cogitator add rag', 'answers grounded in docs/'],
        ['cogitator add workflows evals', 'two features at once'],
        ['cogitator add --memory postgres', 'switch memory to Postgres'],
        ['cogitator add --deploy docker --dry-run', 'see every diff first'],
      ]),
      '',
      'Files you edited are merged where they can be (package.json, cogitator.yml,',
      'docker-compose.yml, the managed block of AGENTS.md, .gitignore). When the',
      'addition needs to change a file you edited in another way, nothing is written',
      'and the change is printed as a diff. Adding what the project has is a no-op.',
    ].join('\n')
  )
  .action(async (features: string[], flags: AddCommandFlags) => {
    process.exitCode = await runAdd(process.cwd(), features, flags);
  });
