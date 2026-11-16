/**
 * cogitator bridge install | uninstall - give the sessions a person opens in Claude Code and
 * Codex the bridge, and take it away again
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  BridgeClient,
  CommandMissingError,
  bridgePaths,
  findCheckoutRoot,
  type AdapterSetup,
  type SetupContext,
  type SetupStep,
} from '@cogitator-ai/bridge';
import {
  INSTALL_LABELS,
  INSTALL_TARGETS,
  bridgeSetups,
  type InstallTarget,
} from '../utils/bridge-adapters.js';
import { CommandError, UsageError, printJson, reportFailure } from '../utils/cli.js';

/** How the commands talk to the person */
export interface BridgeInstallIo {
  print(line: string): void;
  /** Asks a yes or no question. Undefined when nobody is there to answer */
  confirm(question: string): Promise<boolean | undefined>;
}

/** What the commands work with */
export interface BridgeInstallContext {
  io: BridgeInstallIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** How each harness is set up, those of this command line by default */
  setups?: Partial<Record<InstallTarget, AdapterSetup>>;
}

/** Prompts on the terminal, undefined when stdin is not one */
function terminalIo(): BridgeInstallIo {
  return {
    print: (line) => console.log(line),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return undefined;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
  };
}

const defaultContext = (): BridgeInstallContext => ({
  io: terminalIo(),
  env: process.env,
  cwd: process.cwd(),
});

interface SharedFlags {
  home?: string;
  /** The project to set up, the one the current folder is in by default */
  cwd?: string;
  /** For every project of this person, not for this one only */
  user?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface BridgeInstallFlags extends SharedFlags {
  /** False with `--no-notes`: the instructions files stay as they are */
  notes?: boolean;
  /** False with `--no-allow`: Claude Code goes on asking before a session calls a bridge tool */
  allow?: boolean;
  /** Sessions carry out the jobs of other agents without asking the person first */
  takeJobs?: boolean;
}

export type BridgeUninstallFlags = SharedFlags;

/** `all` or one of the harnesses, as the command line names them. */
export const INSTALL_CHOICES = [...INSTALL_TARGETS, 'all'] as const;

function targetsOf(target: string | undefined): InstallTarget[] {
  if (target === undefined || target === 'all') return [...INSTALL_TARGETS];
  const found = INSTALL_TARGETS.find((known) => known === target);
  if (found) return [found];
  throw new UsageError(`"${target}" is not a harness the bridge sets up`, [
    `Use one of: ${INSTALL_CHOICES.join(', ')}`,
  ]);
}

interface Planned {
  target: InstallTarget;
  steps: SetupStep[];
}

interface Plan {
  planned: Planned[];
  /** The harnesses that are not installed on this machine */
  missing: InstallTarget[];
}

/**
 * Asks each harness for its steps. A harness that is not installed is left out when every
 * harness was asked for, and is a failure when it was named.
 */
async function planFor(
  targets: readonly InstallTarget[],
  named: boolean,
  steps: (setup: AdapterSetup) => Promise<SetupStep[]>,
  setups: Partial<Record<InstallTarget, AdapterSetup>>
): Promise<Plan> {
  const plan: Plan = { planned: [], missing: [] };
  for (const target of targets) {
    const setup = setups[target];
    if (!setup) continue;
    try {
      plan.planned.push({ target, steps: await steps(setup) });
    } catch (error) {
      if (!(error instanceof CommandMissingError)) throw error;
      if (named) {
        throw new CommandError(`${INSTALL_LABELS[target]} is not installed: ${error.message}`);
      }
      plan.missing.push(target);
    }
  }
  return plan;
}

function show(plan: Plan, io: BridgeInstallIo): void {
  let number = 0;
  for (const { target, steps } of plan.planned) {
    io.print(chalk.bold(INSTALL_LABELS[target]));
    if (steps.length === 0) io.print(chalk.dim('  nothing to change'));
    for (const step of steps) {
      number += 1;
      io.print(`  ${number}. ${step.title}`);
      for (const line of step.lines) io.print(chalk.dim(`       ${line}`));
    }
  }
  for (const target of plan.missing) {
    io.print(chalk.bold(INSTALL_LABELS[target]));
    io.print(chalk.dim('  not installed on this machine, left out'));
  }
}

function asJson(plan: Plan, applied: boolean): unknown {
  return {
    applied,
    changes: plan.planned.flatMap(({ target, steps }) =>
      steps.map((step) => ({ harness: target, title: step.title, lines: step.lines }))
    ),
    missing: plan.missing,
  };
}

/**
 * Shows the plan, asks, and makes the changes one after another. Returns whether they were made.
 *
 * @throws CommandError when a step fails, naming it and how many were made before it
 */
async function carryOut(
  plan: Plan,
  flags: SharedFlags,
  question: string,
  io: BridgeInstallIo
): Promise<boolean> {
  const steps = plan.planned.flatMap(({ steps: own }) => own);
  if (!flags.json) show(plan, io);
  if (steps.length === 0 || flags.dryRun) return false;
  if (!flags.yes) {
    if (flags.json) {
      throw new UsageError('With --json nothing is asked', [
        'Add --yes to make the changes, or --dry-run to list them',
      ]);
    }
    const answer = await io.confirm(question.replace('%d', String(steps.length)));
    if (answer === undefined) {
      throw new CommandError('Nothing was changed: nobody is here to confirm', {
        hints: ['Run it again with --yes'],
      });
    }
    if (!answer) {
      io.print('Nothing was changed');
      return false;
    }
  }
  for (const [index, step] of steps.entries()) {
    try {
      await step.apply();
    } catch (error) {
      throw new CommandError(
        `"${step.title}" failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          hints: [
            index === 0
              ? 'Nothing was changed before it'
              : `The ${index} change${index === 1 ? '' : 's'} before it ${index === 1 ? 'was' : 'were'} made. Running the command again goes on from here`,
          ],
          cause: error,
        }
      );
    }
  }
  return true;
}

function contextOf(flags: SharedFlags, context: BridgeInstallContext): SetupContext {
  return {
    project: findCheckoutRoot(resolve(context.cwd, flags.cwd ?? '.')),
    scope: flags.user ? 'user' : 'project',
  };
}

async function dispatcherRuns(flags: SharedFlags, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const client = await BridgeClient.connect({
      socketPath: bridgePaths({ ...(flags.home && { home: flags.home }), env }).socket,
      timeoutMs: 3_000,
    });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * cogitator bridge install [claude|codex|all]: gives the sessions a person opens the bridge.
 * Every change is listed first and made only after a yes.
 */
export async function runBridgeInstall(
  target: string | undefined,
  flags: BridgeInstallFlags,
  context: BridgeInstallContext = defaultContext()
): Promise<number> {
  try {
    const setups =
      context.setups ?? bridgeSetups(context.env, { ...(flags.home && { home: flags.home }) });
    const where = contextOf(flags, context);
    const plan = await planFor(
      targetsOf(target),
      target !== undefined && target !== 'all',
      (setup) =>
        setup.install({
          ...where,
          notes: flags.notes !== false,
          takeJobs: flags.takeJobs === true,
          allowTools: flags.allow !== false,
        }),
      setups
    );
    if (plan.planned.length === 0) {
      throw new CommandError('Neither Claude Code nor Codex is installed on this machine');
    }
    if (!flags.json) {
      context.io.print(
        where.scope === 'user'
          ? 'Setting up the agent bridge for every project of yours'
          : `Setting up the agent bridge for the project ${where.project}`
      );
    }
    const applied = await carryOut(plan, flags, 'Make these %d changes?', context.io);
    if (flags.json) {
      printJson(asJson(plan, applied));
      return 0;
    }
    const changes = plan.planned.reduce((count, { steps }) => count + steps.length, 0);
    if (changes === 0) context.io.print(chalk.green('Everything is in place already'));
    if (flags.dryRun || (changes > 0 && !applied)) return 0;
    if (applied)
      context.io.print(chalk.green(`Done: ${changes} change${changes === 1 ? '' : 's'}`));
    if (!(await dispatcherRuns(flags, context.env))) {
      context.io.print(
        chalk.dim('  No dispatcher runs yet. Start the one of this machine: cogitator bridge serve')
      );
    }
    if (applied) {
      context.io.print(
        chalk.dim('  Sessions that are open now get the tools when they are started again')
      );
    }
    context.io.print(chalk.dim('  Check the setup: cogitator bridge doctor'));
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/**
 * cogitator bridge uninstall [claude|codex|all]: takes out what `install` put in, and nothing
 * else. Every change is listed first and made only after a yes.
 */
export async function runBridgeUninstall(
  target: string | undefined,
  flags: BridgeUninstallFlags,
  context: BridgeInstallContext = defaultContext()
): Promise<number> {
  try {
    const setups =
      context.setups ?? bridgeSetups(context.env, { ...(flags.home && { home: flags.home }) });
    const where = contextOf(flags, context);
    const plan = await planFor(
      targetsOf(target),
      target !== undefined && target !== 'all',
      (setup) => setup.uninstall(where),
      setups
    );
    if (!flags.json) {
      context.io.print(
        where.scope === 'user'
          ? 'Taking the agent bridge out of every project of yours'
          : `Taking the agent bridge out of the project ${where.project}`
      );
    }
    const applied = await carryOut(plan, flags, 'Make these %d changes?', context.io);
    if (flags.json) {
      printJson(asJson(plan, applied));
      return 0;
    }
    const changes = plan.planned.reduce((count, { steps }) => count + steps.length, 0);
    if (changes === 0) context.io.print(chalk.green('Nothing of the bridge is set up here'));
    if (applied)
      context.io.print(chalk.green(`Done: ${changes} change${changes === 1 ? '' : 's'}`));
    if (where.scope === 'project' && plan.planned.some(({ target: name }) => name === 'codex')) {
      context.io.print(
        chalk.dim(
          '  Codex keeps its servers for every project: its server of tools goes with cogitator bridge uninstall codex --user'
        )
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}
