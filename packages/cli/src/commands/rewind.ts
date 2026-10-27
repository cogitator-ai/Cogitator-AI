/**
 * cogitator rewind <thread> [entry] - rewind a thread's conversation, memory and files
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Agent, Cogitator, RewindOptions, RewindReport } from '@cogitator-ai/core';
import { fileCheckpointOf, type MemoryEntry } from '@cogitator-ai/types';
import { CommandError, examplesHelp, printJson, reportFailure, UsageError } from '../utils/cli.js';
import { loadDotenvInto } from '../utils/env.js';
import { importUserModule } from '../utils/module-loader.js';

/** Where a scaffolded project registers its runtime and agents. */
export const DEFAULT_REGISTRY = 'src/cogitator.ts';

export interface RewindFlags {
  registry?: string;
  agent?: string;
  files?: boolean;
  memory?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
}

/** What the command works on: the project's runtime and its agents by key */
export interface RewindProject {
  cogitator: Pick<Cogitator, 'rewind' | 'getMemory'> & { readonly durableByDefault?: boolean };
  agents: Map<string, Agent>;
}

/** How the command talks to the person running it */
export interface RewindIo {
  print(line: string): void;
  /** Asks a yes or no question, undefined when nobody can answer (not a terminal) */
  confirm(question: string): Promise<boolean | undefined>;
}

function isRuntime(value: unknown): value is RewindProject['cogitator'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rewind' in value &&
    typeof value.rewind === 'function' &&
    'getMemory' in value &&
    typeof value.getMemory === 'function'
  );
}

function isAgent(value: unknown): value is Agent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'config' in value &&
    typeof value.config === 'object' &&
    value.config !== null
  );
}

/**
 * Loads `.env` and the registry of the project in `projectDir`: the runtime it exports as
 * `cogitator` and its agents, exported as `agents` by key
 */
export async function loadRewindProject(
  projectDir: string,
  registry = DEFAULT_REGISTRY
): Promise<RewindProject> {
  const path = resolve(projectDir, registry);
  if (!existsSync(path)) {
    throw new CommandError(`Registry not found: ${path}`, {
      hints: [
        'Export the runtime as `cogitator` and the agents as `agents` from src/cogitator.ts, or pass --registry',
      ],
    });
  }
  loadDotenvInto(resolve(projectDir, '.env'), process.env);
  const module = await importUserModule(path, projectDir);
  if (!isRuntime(module.cogitator)) {
    throw new CommandError(`${registry} does not export the runtime as \`cogitator\``);
  }
  const agents = new Map<string, Agent>();
  const group = module.agents;
  if (typeof group === 'object' && group !== null) {
    for (const [key, value] of Object.entries(group)) if (isAgent(value)) agents.set(key, value);
  }
  return { cogitator: module.cogitator, agents };
}

function oneLine(entry: MemoryEntry): string {
  const content = entry.message.content;
  const text =
    typeof content === 'string'
      ? content
      : content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? `${flat.slice(0, 69)}...` : flat;
}

function entryLabel(entry: MemoryEntry): string {
  const type = entry.type ?? 'message';
  if (type === 'message') return entry.message.role;
  return type;
}

/** The lines that tell what a rewind did or would do */
export function describeRewind(report: RewindReport): string[] {
  const would = report.dryRun ? 'would ' : '';
  const lines: string[] = [];
  const cut = report.conversation.cut.length;
  lines.push(
    cut === 0
      ? `Conversation: ${report.dryRun ? 'stays' : 'stayed'} where it is`
      : `Conversation: ${cut} entr${cut === 1 ? 'y' : 'ies'} ${would}leave the active branch`
  );
  if (report.items.stale.length > 0) {
    lines.push(`Memory: ${report.items.stale.length} item(s) ${would}become stale`);
  }
  if (report.files) {
    const { restored, deleted, kept, exact } = report.files;
    lines.push(
      `Files: ${restored.length} ${would}be restored, ${deleted.length} ${would}be deleted${
        exact ? '' : ' (from the checkpoint before that turn)'
      }`
    );
    for (const path of restored) lines.push(`  ${chalk.green('restore')} ${path}`);
    for (const path of deleted) lines.push(`  ${chalk.red('delete')}  ${path}`);
    for (const path of kept) lines.push(`  ${chalk.dim('keep')}    ${path}`);
  }
  if (report.runs.paused) lines.push(`Runs: the paused run ${would}be dropped`);
  if (report.runs.durable.length > 0) {
    lines.push(`Runs: ${report.runs.durable.length} durable run(s) ${would}be dropped`);
  }
  if (report.runs.going.length > 0 && report.dryRun) {
    lines.push(`Runs: ${report.runs.going.length} going on, pass --force to abort them`);
  }
  if (report.runs.interrupted.length > 0) {
    lines.push(`Runs: ${report.runs.interrupted.length} aborted`);
  }
  return lines;
}

/**
 * Lists the active branch of `threadId` with the entries a rewind can go to, or rewinds it to
 * `entryId`: a dry run first, printed, then the rewind once confirmed (`--yes`, or a yes at the
 * prompt). Returns the exit code
 */
export async function runRewind(
  project: RewindProject,
  threadId: string,
  entryId: string | undefined,
  flags: RewindFlags,
  io: RewindIo
): Promise<number> {
  const memory = await project.cogitator.getMemory();
  if (!memory?.getPath) {
    throw new CommandError('The project has no memory with branches to rewind', {
      hints: ['Set memory.adapter in the Cogitator config of the registry'],
    });
  }
  const thread = await memory.getThread(threadId);
  if (!thread.success) throw new CommandError(thread.error);
  if (!thread.data) throw new CommandError(`Thread ${threadId} does not exist`);
  const agent = agentFor(project, thread.data.agentId, flags);
  if (flags.json && entryId !== undefined && !flags.yes && !flags.dryRun) {
    throw new UsageError(
      '--json does not prompt: pass --dry-run to see the plan, or --yes to rewind'
    );
  }

  if (entryId === undefined) {
    const path = await memory.getPath({ threadId, types: 'all' });
    if (!path.success) throw new CommandError(path.error);
    if (flags.json) {
      printJson({
        ok: true,
        threadId,
        entries: path.data.map((entry) => ({
          id: entry.id,
          type: entry.type ?? 'message',
          role: entry.message.role,
          text: oneLine(entry),
          checkpoint: fileCheckpointOf(entry.metadata) !== undefined,
        })),
      });
      return 0;
    }
    io.print(chalk.bold(`Thread ${threadId}, active branch, oldest first:`));
    for (const entry of path.data) {
      const mark = fileCheckpointOf(entry.metadata) ? chalk.cyan(' [files]') : '';
      io.print(`  ${chalk.dim(entry.id)}  ${entryLabel(entry).padEnd(9)} ${oneLine(entry)}${mark}`);
    }
    io.print(
      chalk.dim(
        'Entries marked [files] took a file checkpoint: rewind with --files to restore the files too.'
      )
    );
    return 0;
  }

  if (flags.files && !agent?.config.workspace) {
    throw new UsageError(
      'Restoring files needs the workspace of the agent the thread ran with, and no registry agent was found for it',
      [`Pass --agent <key> (agents: ${[...project.agents.keys()].join(', ') || 'none'})`]
    );
  }
  const warnings =
    project.cogitator.durableByDefault === false
      ? [
          'Runs are not durable in this project, so a run another process is running now cannot be seen from here: make sure none is before you rewind',
        ]
      : [];
  if (!flags.json) for (const warning of warnings) io.print(chalk.yellow(`! ${warning}`));
  const options: RewindOptions = {
    ...(agent && { agents: [agent] }),
    ...(flags.files !== undefined && { files: flags.files }),
    ...(flags.memory === false && { memory: false }),
    ...(flags.force && { force: true }),
  };
  const plan = await project.cogitator.rewind(threadId, entryId, { ...options, dryRun: true });
  if (flags.dryRun) {
    if (flags.json) printJson({ ok: true, report: plan, warnings });
    else for (const line of describeRewind(plan)) io.print(line);
    return 0;
  }
  if (!flags.yes) {
    for (const line of describeRewind(plan)) io.print(line);
    const answer = await io.confirm(`Rewind thread ${threadId} to ${entryId}?`);
    if (answer === undefined) {
      throw new UsageError('Not a terminal: pass --yes to rewind without a prompt');
    }
    if (!answer) {
      io.print('Nothing changed.');
      return 0;
    }
  }
  const report = await project.cogitator.rewind(threadId, entryId, options);
  if (flags.json) printJson({ ok: true, report, warnings });
  else for (const line of describeRewind(report)) io.print(line);
  return 0;
}

/**
 * The registry agent whose workspace and memory a rewind uses: `--agent`, else the one whose id
 * the thread names, else the only agent of the registry with a workspace (an agent without a
 * configured `id` gets a new one in every process, so the thread's id cannot name it)
 */
function agentFor(
  project: RewindProject,
  threadAgentId: string,
  flags: RewindFlags
): Agent | undefined {
  const agents = [...project.agents.values()];
  if (flags.agent) {
    const named = project.agents.get(flags.agent);
    if (!named) {
      throw new UsageError(`The registry has no agent "${flags.agent}"`, [
        `Agents: ${[...project.agents.keys()].join(', ') || 'none'}`,
      ]);
    }
    return named;
  }
  const owner = agents.find((candidate) => candidate.id === threadAgentId);
  if (owner) return owner;
  const withWorkspace = agents.filter((candidate) => candidate.config.workspace !== undefined);
  return withWorkspace.length === 1 ? withWorkspace[0] : undefined;
}

/** Prompts on the terminal, undefined when stdin is not one */
function terminalIo(): RewindIo {
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

export const rewindCommand = new Command('rewind')
  .description(
    'Rewind a thread to an entry: its conversation and memory, and with --files the files of the workspace'
  )
  .argument('<thread>', 'The thread to rewind')
  .argument('[entry]', 'The entry to rewind to, leave it out to list the entries of the thread')
  .option('--files', 'Restore the files from the checkpoint at that point')
  .option('--no-memory', 'Leave the conversation and memory as they are, restore the files only')
  .option('--dry-run', 'Show what the rewind would change, change nothing')
  .option('-y, --yes', 'Rewind without asking')
  .option(
    '--force',
    'Stop the runs going on in the thread (and with --files in its workspace) first. Only runs of this process and durable runs of others are seen'
  )
  .option(
    '-a, --agent <key>',
    'The registry agent whose workspace to restore (default: the thread one)'
  )
  .option('-r, --registry <path>', 'The registry module', DEFAULT_REGISTRY)
  .option('--json', 'Print the result as JSON')
  .addHelpText(
    'after',
    `
Runs going on: the command runs in a process of its own, so it sees a run of the project's
other processes only when that run is durable (CogitatorConfig.durable): a run that is not
is not detected. Stop such runs before you rewind with --files.
` +
      examplesHelp([
        ['cogitator rewind thread_42', 'list the entries of the thread'],
        ['cogitator rewind thread_42 entry_abc --files --dry-run', 'show what would change'],
        ['cogitator rewind thread_42 entry_abc --files', 'rewind conversation, memory and files'],
        ['cogitator rewind thread_42 entry_abc --files --no-memory -y', 'restore the files only'],
      ])
  )
  .action(async (thread: string, entry: string | undefined, flags: RewindFlags) => {
    let code: number;
    try {
      const project = await loadRewindProject(process.cwd(), flags.registry);
      code = await runRewind(project, thread, entry, flags, terminalIo());
    } catch (error) {
      code = reportFailure(error, { json: flags.json === true });
    }
    process.exit(code);
  });
