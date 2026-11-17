#!/usr/bin/env node
/**
 * Cogitator CLI
 */

import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { exitCodeFor, reportFailure } from './utils/cli.js';

const args = process.argv.slice(2);

createProgram(args)
  .then((program) => program.parseAsync())
  .catch((error: unknown) => {
    if (error instanceof CommanderError) process.exit(exitCodeFor(error, args));
    process.exit(reportFailure(error, { json: args.includes('--json') }));
  });
