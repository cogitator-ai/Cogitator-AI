#!/usr/bin/env node
/**
 * Cogitator CLI
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCommand } from './commands/init.js';
import { upCommand, downCommand } from './commands/up.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { modelsCommand } from './commands/models.js';
import { deployCommand } from './commands/deploy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

const program = new Command()
  .name('cogitator')
  .description('Cogitator AI Agent Runtime CLI')
  .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(runCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(modelsCommand);
program.addCommand(deployCommand);

program.parse();
