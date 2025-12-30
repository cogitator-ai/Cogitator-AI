#!/usr/bin/env node
/**
 * Cogitator CLI
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { upCommand, downCommand } from './commands/up.js';
import { runCommand } from './commands/run.js';

const program = new Command()
  .name('cogitator')
  .description('Cogitator AI Agent Runtime CLI')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(runCommand);

program.parse();
