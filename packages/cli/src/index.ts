#!/usr/bin/env node
/**
 * Cogitator CLI
 */

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { upCommand, downCommand } from './commands/up';
import { runCommand } from './commands/run';

const program = new Command()
  .name('cogitator')
  .description('Cogitator AI Agent Runtime CLI')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(upCommand);
program.addCommand(downCommand);
program.addCommand(runCommand);

program.parse();
