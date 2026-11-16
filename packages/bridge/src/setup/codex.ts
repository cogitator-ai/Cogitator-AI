import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { failureOf, outsideSessionEnv, runCommand, shellQuote } from '../adapters/exec.js';
import { BRIDGE_TOOLS_SERVER, type ToolsServerCommand } from '../adapters/tools-server.js';
import { bridgeNotes } from '../tools/guidance.js';
import { notesStep, removeNotesStep } from './files.js';
import type { AdapterSetup, InstallContext, SetupContext, SetupStep } from './setup.js';

export interface CodexSetupOptions {
  /** How a thread starts the bridge's server of tools */
  toolsServer: ToolsServerCommand;
  /** The Codex executable, `codex` on `PATH` by default */
  command?: string;
  /** The environment of the commands, `process.env` by default */
  env?: NodeJS.ProcessEnv;
  /** Where Codex reads a person's instructions for every project, `AGENTS.md` in its home */
  userNotesPath?: string;
}

const ServerSchema = z.object({
  transport: z.object({
    command: z.string().optional(),
    args: z.array(z.string()).nullish(),
  }),
});

/**
 * How Codex is given the bridge for the threads a person opens: the server of tools
 * (`codex mcp add`) and the notes in `AGENTS.md`. Codex needs no hook: the bridge hands a thread
 * its mail through the thread's own queue, and Codex names the thread in every tool call.
 *
 * Codex keeps its servers in one place for every project, so the server is registered for all
 * of them whichever scope is asked for, and only an uninstall for every project removes it.
 */
export function codexSetup(options: CodexSetupOptions): AdapterSetup {
  const command = options.command ?? 'codex';
  const base = options.env ?? process.env;
  const env = outsideSessionEnv(base);
  const userNotesPath =
    options.userNotesPath ??
    join(base.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'AGENTS.md');
  const server = options.toolsServer;

  const notesPath = (context: SetupContext): string =>
    context.scope === 'user' ? userNotesPath : join(resolve(context.project), 'AGENTS.md');

  const shown = (args: readonly string[]): string =>
    [command, ...args].map((word) => shellQuote(word)).join(' ');

  async function run(args: string[]): Promise<void> {
    const result = await runCommand(command, args, { env });
    if (result.code !== 0) {
      throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${failureOf(result)}`);
    }
  }

  /** The command Codex starts the server of tools with, when it has the server. */
  async function registered(): Promise<{ command?: string; args: string[] } | undefined> {
    const result = await runCommand(command, ['mcp', 'get', BRIDGE_TOOLS_SERVER, '--json'], {
      env,
    });
    if (result.code !== 0) return undefined;
    let shownServer: unknown;
    try {
      shownServer = JSON.parse(result.stdout);
    } catch {
      return { args: [] };
    }
    const parsed = ServerSchema.safeParse(shownServer);
    if (!parsed.success) return { args: [] };
    const { command: started, args } = parsed.data.transport;
    return { ...(started !== undefined && { command: started }), args: args ?? [] };
  }

  async function install(context: InstallContext): Promise<SetupStep[]> {
    const version = await runCommand(command, ['--version'], { env });
    if (version.code !== 0) throw new Error(`${command} --version failed: ${failureOf(version)}`);
    const steps: SetupStep[] = [];

    const has = await registered();
    if (has?.command !== server.command || has.args.join('\0') !== server.args.join('\0')) {
      const addition = ['mcp', 'add', BRIDGE_TOOLS_SERVER, '--', server.command, ...server.args];
      steps.push({
        title: `${has ? 'Replace' : 'Register'} the bridge's server of tools with Codex, which keeps its servers for every project`,
        lines: [shown(addition)],
        apply: () => run(addition),
      });
    }

    if (context.notes) {
      const notes = notesStep(notesPath(context), bridgeNotes({ takeJobs: context.takeJobs }));
      if (notes) steps.push(notes);
    }
    return steps;
  }

  async function uninstall(context: SetupContext): Promise<SetupStep[]> {
    const steps: SetupStep[] = [];
    if (context.scope === 'user' && (await registered())) {
      const removal = ['mcp', 'remove', BRIDGE_TOOLS_SERVER];
      steps.push({
        title: "Remove the bridge's server of tools from Codex",
        lines: [shown(removal)],
        apply: () => run(removal),
      });
    }
    const notes = removeNotesStep(notesPath(context));
    if (notes) steps.push(notes);
    return steps;
  }

  return { install, uninstall };
}
