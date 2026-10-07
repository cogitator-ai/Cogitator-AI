import chalk from 'chalk';
import {
  CHANNELS,
  CODING_AGENTS,
  closest,
  DEPLOY_TARGETS,
  FEATURES,
  MEMORIES,
  VECTOR_STORES,
  type AddChanges,
  type AddPlan,
  type AddResult,
  type FileChange,
} from 'create-cogitator-app';
import { UsageError } from './cli.js';

export interface AddFlags {
  memory?: string;
  vectorStore?: string;
  deploy?: string;
  channel?: string[];
  agent?: string[];
}

function oneOf<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found) return found;
  const match = closest(value, allowed);
  throw new UsageError(
    `Unknown ${what} "${value}".${match ? ` Did you mean "${match}"?` : ''} Use one of: ${allowed.join(', ')}.`
  );
}

/** Values of a repeatable flag, which also takes comma-separated lists. */
function listOf(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The addition the command line asks for, validated against the scaffolder's catalogs. */
export function addChangesFrom(features: readonly string[], flags: AddFlags): AddChanges {
  const changes: AddChanges = {
    features: listOf(features).map((feature) => oneOf('feature', feature, FEATURES)),
    channels: listOf(flags.channel).map((channel) => oneOf('channel', channel, CHANNELS)),
    codingAgents: listOf(flags.agent).map((agent) => oneOf('coding agent', agent, CODING_AGENTS)),
    ...(flags.memory && { memory: oneOf('memory', flags.memory, MEMORIES) }),
    ...(flags.vectorStore && {
      vectorStore: oneOf('vector store', flags.vectorStore, VECTOR_STORES),
    }),
    ...(flags.deploy && { deploy: oneOf('deploy target', flags.deploy, DEPLOY_TARGETS) }),
  };
  const empty =
    !changes.features?.length &&
    !changes.channels?.length &&
    !changes.codingAgents?.length &&
    !changes.memory &&
    !changes.vectorStore &&
    !changes.deploy;
  if (empty) {
    throw new UsageError(
      `Name what to add: a feature (${FEATURES.join(', ')}), or --memory, --vector-store, --deploy, --channel, --agent`
    );
  }
  return changes;
}

/** A unified diff with additions in green, removals in red and hunk headers dimmed. */
export function colorDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      return line;
    })
    .join('\n');
}

const MARKS: Record<FileChange['kind'], string> = {
  create: chalk.green('+'),
  update: chalk.yellow('~'),
  delete: chalk.red('-'),
};

function indentList(items: readonly string[]): string[] {
  return items.map((item) => `  ${item}`);
}

/** What the addition does, for the terminal; with `diffs`, every file change in full. */
export function formatAddPlan(plan: AddPlan, options: { diffs: boolean }): string {
  const out: string[] = [];
  if (plan.upToDate)
    return chalk.green('The project already has everything asked for, nothing to do.');

  out.push(chalk.bold(`Adding ${plan.summary.join(', ')}`), '');
  if (plan.changes.length > 0) {
    out.push(chalk.bold('Files'));
    for (const change of plan.changes) {
      const how = change.source === 'merged' ? chalk.dim(' (merged with your edits)') : '';
      out.push(`  ${MARKS[change.kind]} ${change.path}${how}`);
    }
    out.push('');
  }
  const deps = Object.entries({ ...plan.dependencies, ...plan.devDependencies });
  if (deps.length > 0) {
    out.push(
      chalk.bold('Dependencies'),
      ...indentList(deps.map(([name, range]) => `${name} ${chalk.dim(range)}`)),
      ''
    );
  }
  if (plan.env.length > 0) {
    out.push(
      chalk.bold('Environment'),
      ...indentList(
        plan.env.map(
          (variable) =>
            `${variable.name}${variable.required ? chalk.yellow(' (required)') : ''} ${chalk.dim(variable.description)}`
        )
      ),
      ''
    );
  }
  if (plan.services.length > 0) {
    out.push(chalk.bold('Services'), ...indentList(plan.services), '');
  }
  for (const note of plan.notes) {
    out.push(chalk.dim(`note: ${note.path ? `${note.path} ` : ''}${note.message}`));
    if (options.diffs && note.diff) out.push(colorDiff(note.diff));
  }
  for (const warning of plan.warnings) out.push(chalk.yellow(`warning: ${warning}`));
  if (options.diffs) {
    for (const change of plan.changes)
      if (change.diff) out.push('', colorDiff(change.diff.trimEnd()));
  }
  return out.join('\n').trimEnd();
}

/** Why the addition was refused, with the change each conflicting file needs. */
export function formatConflicts(plan: AddPlan): string {
  return [
    chalk.red(
      `cogitator add would overwrite your changes to ${plan.conflicts.length} file${plan.conflicts.length === 1 ? '' : 's'}, so nothing was written:`
    ),
    ...plan.conflicts.flatMap((conflict) => [
      '',
      `${chalk.bold(conflict.path)}: ${conflict.reason}`,
      colorDiff(conflict.diff.trimEnd()),
    ]),
    '',
    'Apply these changes by hand, or set your edits aside and restore the generated files, then run cogitator add again.',
  ].join('\n');
}

/** The plan as `--json` prints it: no file contents, diffs included. */
export function addPlanJson(
  plan: AddPlan,
  result?: Pick<AddResult, 'written' | 'deleted' | 'install' | 'format'>
) {
  const step = (value: AddResult['install'] | undefined) =>
    value && (value.status === 'failed' ? { status: 'failed', error: value.error.message } : value);
  return {
    ok: plan.conflicts.length === 0,
    upToDate: plan.upToDate,
    added: plan.summary,
    spec: plan.to,
    command: plan.command,
    changes: plan.changes.map(({ path, kind, source, diff }) => ({ path, kind, source, diff })),
    conflicts: plan.conflicts,
    notes: plan.notes,
    dependencies: plan.dependencies,
    devDependencies: plan.devDependencies,
    env: plan.env.map(({ name, required, secret, description }) => ({
      name,
      required,
      secret,
      description,
    })),
    services: plan.services,
    warnings: plan.warnings,
    ...(result && {
      written: result.written,
      deleted: result.deleted,
      install: step(result.install),
      format: step(result.format),
    }),
  };
}
