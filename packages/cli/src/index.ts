#!/usr/bin/env node
/**
 * Cogitator CLI
 */

import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { exitCodeOf, reportFailure } from './utils/cli.js';

createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    if (error instanceof CommanderError) process.exit(exitCodeOf(error));
    process.exit(reportFailure(error, { json: process.argv.includes('--json') }));
  });
