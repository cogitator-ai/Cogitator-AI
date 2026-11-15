#!/usr/bin/env node
/**
 * Cogitator CLI
 */

import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { exitCodeFor, reportFailure } from './utils/cli.js';

createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    if (error instanceof CommanderError) process.exit(exitCodeFor(error, process.argv.slice(2)));
    process.exit(reportFailure(error, { json: process.argv.includes('--json') }));
  });
