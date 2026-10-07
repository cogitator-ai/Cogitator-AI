import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCommand } from './commands/init.js';
import { addCommand } from './commands/add.js';
import { mcpCommand } from './commands/mcp.js';
import { devCommand } from './commands/dev.js';
import { doctorCommand } from './commands/doctor.js';
import { evalCommand } from './commands/eval.js';
import { upCommand, downCommand } from './commands/up.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { modelsCommand } from './commands/models.js';
import { deployCommand } from './commands/deploy.js';
import { assistantCommand } from './commands/assistant.js';
import { buildCommand } from './commands/build.js';
import { daemonCommand } from './commands/daemon.js';
import { skillCommand } from './commands/skill.js';
import { wizardCommand } from './commands/wizard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

/** Commander errors reach the entry point from every command, so they exit with the same codes. */
function configure(command: Command): void {
  command.showSuggestionAfterError().exitOverride();
  for (const sub of command.commands) configure(sub);
}

/** The `cogitator` command with every subcommand. */
export function createProgram(): Command {
  const program = new Command()
    .name('cogitator')
    .description('Cogitator AI Agent Runtime CLI')
    .version(pkg.version);
  for (const command of [
    initCommand,
    addCommand,
    devCommand,
    doctorCommand,
    evalCommand,
    mcpCommand,
    upCommand,
    downCommand,
    runCommand,
    statusCommand,
    logsCommand,
    modelsCommand,
    deployCommand,
    assistantCommand,
    buildCommand,
    daemonCommand,
    skillCommand,
    wizardCommand,
  ]) {
    program.addCommand(command);
  }
  configure(program);
  return program;
}
