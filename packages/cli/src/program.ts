import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

/**
 * A subcommand of `cogitator` and the module that builds it. The module is imported only when
 * the command line needs the command, so one command does not pay for what the others import.
 */
export interface CommandEntry {
  /** The name of the command, then its aliases, as the command itself declares them */
  names: readonly string[];
  load(): Promise<Command>;
}

/** Every subcommand, in the order the help lists them. */
export const COMMAND_ENTRIES: readonly CommandEntry[] = [
  { names: ['init'], load: async () => (await import('./commands/init.js')).initCommand },
  { names: ['add'], load: async () => (await import('./commands/add.js')).addCommand },
  { names: ['dev'], load: async () => (await import('./commands/dev.js')).devCommand },
  { names: ['doctor'], load: async () => (await import('./commands/doctor.js')).doctorCommand },
  { names: ['eval'], load: async () => (await import('./commands/eval.js')).evalCommand },
  { names: ['mcp'], load: async () => (await import('./commands/mcp.js')).mcpCommand },
  { names: ['up'], load: async () => (await import('./commands/up.js')).upCommand },
  { names: ['down'], load: async () => (await import('./commands/up.js')).downCommand },
  { names: ['run'], load: async () => (await import('./commands/run.js')).runCommand },
  {
    names: ['app-server'],
    load: async () => (await import('./commands/app-server.js')).appServerCommand,
  },
  { names: ['acp'], load: async () => (await import('./commands/acp.js')).acpCommand },
  { names: ['bridge'], load: async () => (await import('./commands/bridge.js')).bridgeCommand },
  {
    names: ['status', 'ps'],
    load: async () => (await import('./commands/status.js')).statusCommand,
  },
  { names: ['logs'], load: async () => (await import('./commands/logs.js')).logsCommand },
  { names: ['models'], load: async () => (await import('./commands/models.js')).modelsCommand },
  { names: ['deploy'], load: async () => (await import('./commands/deploy.js')).deployCommand },
  {
    names: ['assistant'],
    load: async () => (await import('./commands/assistant.js')).assistantCommand,
  },
  { names: ['build'], load: async () => (await import('./commands/build.js')).buildCommand },
  { names: ['daemon'], load: async () => (await import('./commands/daemon.js')).daemonCommand },
  { names: ['skill'], load: async () => (await import('./commands/skill.js')).skillCommand },
  { names: ['wizard'], load: async () => (await import('./commands/wizard.js')).wizardCommand },
  { names: ['rewind'], load: async () => (await import('./commands/rewind.js')).rewindCommand },
  {
    names: ['plugin', 'plugins'],
    load: async () => (await import('./commands/plugin.js')).pluginCommand,
  },
  {
    names: ['schedule', 'schedules'],
    load: async () => (await import('./commands/triggers.js')).scheduleCommand,
  },
  { names: ['inbox'], load: async () => (await import('./commands/triggers.js')).inboxCommand },
  {
    names: ['trigger', 'triggers'],
    load: async () => (await import('./commands/triggers.js')).triggerCommand,
  },
];

const VERSION_FLAGS = ['-V', '--version'];

/**
 * The subcommands a command line can reach. A line that starts with the name of a command
 * reaches that command alone, and one that starts with the version flag reaches none. Anything
 * else (the help, a mistyped command, an option before the command) may show or suggest any of
 * them, so it gets them all.
 */
export function commandEntriesFor(args: readonly string[] | undefined): readonly CommandEntry[] {
  const first = args?.[0];
  if (first === undefined) return COMMAND_ENTRIES;
  if (VERSION_FLAGS.includes(first)) return [];
  const entry = COMMAND_ENTRIES.find((candidate) => candidate.names.includes(first));
  return entry ? [entry] : COMMAND_ENTRIES;
}

/** Commander errors reach the entry point from every command, so they exit with the same codes. */
function configure(command: Command): void {
  command.showSuggestionAfterError().exitOverride();
  for (const sub of command.commands) configure(sub);
}

/**
 * The `cogitator` command. Given the arguments of a command line it holds the subcommands that
 * line can reach, without them it holds every subcommand.
 */
export async function createProgram(args?: readonly string[]): Promise<Command> {
  const program = new Command()
    .name('cogitator')
    .description('Cogitator AI Agent Runtime CLI')
    .version(pkg.version);
  const commands = await Promise.all(commandEntriesFor(args).map((entry) => entry.load()));
  for (const command of commands) program.addCommand(command);
  configure(program);
  return program;
}
