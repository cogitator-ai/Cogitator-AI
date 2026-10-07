import chalk from 'chalk';
import { CommanderError } from 'commander';

/**
 * Exit codes every command uses: 0 when it did what was asked, 1 when it
 * could not (a failed check, a failed deploy, a missing service), 2 when
 * the command line itself is wrong.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure a command reports to the user, with what to do about it. */
export class CommandError extends Error {
  readonly exitCode: ExitCode;
  readonly hints: string[];

  constructor(
    message: string,
    options: { hints?: string[]; exitCode?: ExitCode; cause?: unknown } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CommandError';
    this.exitCode = options.exitCode ?? EXIT.failed;
    this.hints = options.hints ?? [];
  }
}

/** A command line that cannot work: an unknown value, a missing argument. Exits 2. */
export class UsageError extends CommandError {
  constructor(message: string, hints: string[] = []) {
    super(message, { hints, exitCode: EXIT.usage });
    this.name = 'UsageError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `COGITATOR_DEBUG` asks for stack traces. */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COGITATOR_DEBUG?.trim().toLowerCase();
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

const USAGE_CODES = new Set([
  'commander.unknownOption',
  'commander.unknownCommand',
  'commander.missingArgument',
  'commander.missingMandatoryOptionValue',
  'commander.optionMissingArgument',
  'commander.invalidArgument',
  'commander.excessArguments',
  'commander.conflictingOption',
]);

/** The exit code of any error a command ends with. */
export function exitCodeOf(error: unknown): ExitCode {
  if (error instanceof CommandError) return error.exitCode;
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) return EXIT.ok;
    return USAGE_CODES.has(error.code) ? EXIT.usage : EXIT.failed;
  }
  return EXIT.failed;
}

/**
 * Prints how a command failed: as `{ ok: false, error }` on stdout with
 * `--json`, otherwise as a message with its hints on stderr, with the stack
 * when COGITATOR_DEBUG is set. Returns the exit code.
 */
export function reportFailure(
  error: unknown,
  options: { json: boolean; env?: NodeJS.ProcessEnv }
): ExitCode {
  const code = exitCodeOf(error);
  const hints = error instanceof CommandError ? error.hints : [];
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: {
            message: errorMessage(error),
            exitCode: code,
            ...(hints.length > 0 && { hints }),
          },
        },
        null,
        2
      )
    );
    return code;
  }
  console.error(chalk.red('✗'), errorMessage(error));
  for (const hint of hints) console.error(chalk.dim(`  ${hint}`));
  if (debugEnabled(options.env) && error instanceof Error && error.stack) {
    console.error(chalk.dim(error.stack));
  } else if (!(error instanceof CommandError)) {
    console.error(chalk.dim('  Set COGITATOR_DEBUG=1 for the stack trace.'));
  }
  return code;
}

/** The `Examples:` block of a command's help: each command with what it does. */
export function examplesHelp(
  examples: ReadonlyArray<readonly [command: string, description: string]>
): string {
  const width = Math.max(...examples.map(([command]) => command.length));
  return [
    '',
    'Examples:',
    ...examples.map(
      ([command, description]) => `  $ ${command.padEnd(width)}  ${chalk.dim(description)}`
    ),
  ].join('\n');
}

/** Prints `value` as the JSON a `--json` command answers with. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Ends the process with the failure, for code that cannot throw to the
 * command: event handlers of child processes and signal handlers.
 */
export function exitWithFailure(error: unknown): never {
  process.exit(reportFailure(error, { json: false }));
}
