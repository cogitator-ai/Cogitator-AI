import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AGENT_NAME_ENV, HARNESS_ENV, HARNESS_SESSION_ENV, SESSION_NAME_ENV } from '../registry.js';
import type { RenderedLetter } from '../types.js';

/** How a command of a harness ended. */
export interface CommandResult {
  /** Null when a signal ended it */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the command's stdin, which is then closed */
  input?: string;
  /** 30 s by default. The command is killed when it passes */
  timeoutMs?: number;
}

/** The harness's command is not installed, or not on `PATH`. */
export class CommandMissingError extends Error {
  constructor(readonly command: string) {
    super(`${command} is not installed, or not on PATH`);
    this.name = 'CommandMissingError';
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * How long the output of a command that exited is still read. A command that leaves a process
 * of its own behind (a background service holding the same pipes) would otherwise never be done.
 */
const DRAIN_MS = 250;

/** The most output of a command that is kept: what a harness prints for the bridge is short. */
const MAX_OUTPUT_CHARS = 1_000_000;

/**
 * Runs a command of a harness to its end, without a shell.
 *
 * @throws CommandMissingError when the command is not there
 * @throws Error when it does not end in `timeoutMs`
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code !== 'ENOENT') reject(error);
      else if (options.cwd !== undefined && !existsSync(options.cwd)) {
        reject(new Error(`The folder ${options.cwd} does not exist`));
      } else reject(new CommandMissingError(command));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const settle = () => {
        clearTimeout(drain);
        child.stdout.destroy();
        child.stderr.destroy();
        if (timedOut) {
          reject(
            new Error(
              `${command} ${args[0] ?? ''} did not answer in ${Math.round(timeoutMs / 1000)} s`
            )
          );
          return;
        }
        resolve({ code, stdout, stderr });
      };
      const drain = setTimeout(settle, DRAIN_MS);
      child.once('close', settle);
    });
  });
}

/** What a command said when it failed: its stderr, else its stdout, on one line. */
export function failureOf(result: CommandResult): string {
  const said = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(0, 3).join(' ');
  return said || `it ended with ${result.code === null ? 'a signal' : `exit code ${result.code}`}`;
}

/**
 * What a harness puts into the environment of one session about that session: which session it
 * is, how it was entered, the socket and the token its own messages go through. A dispatcher
 * started from inside a session has them, and a session it starts must not: it is another
 * session, often of another harness.
 */
const SURROUNDING_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

/**
 * The environment of a session the bridge starts: what belongs to the session the dispatcher
 * itself may run in is taken out (the new session gets its own from its harness), and the
 * bridge's name for the session goes in, so its first call is recognized.
 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  session: { harness: string; agentName: string; sessionName?: string }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const { variable } of HARNESS_SESSION_ENV) delete env[variable];
  for (const variable of SURROUNDING_SESSION_ENV) delete env[variable];
  delete env[SESSION_NAME_ENV];
  env[HARNESS_ENV] = session.harness;
  env[AGENT_NAME_ENV] = session.agentName;
  if (session.sessionName) env[SESSION_NAME_ENV] = session.sessionName;
  return env;
}

/**
 * The most bytes of text handed to a harness as one argument. The arguments and the environment
 * of a process share about a megabyte on macOS, and a letter may be 200000 characters long.
 */
export const MAX_ARGUMENT_BYTES = 120_000;

export function fitsArgument(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= MAX_ARGUMENT_BYTES;
}

/**
 * What a session gets in place of a letter too long for an argument: the letter's signature and
 * how to read the rest, with the bridge's command line as the session can run it. The letter
 * itself stays unread in the session's inbox.
 */
export function tooLongNotice(
  letter: RenderedLetter,
  bridgeCommand = 'cogitator bridge',
  bridgeHome?: string
): string {
  const signature = letter.text.split('\n', 1)[0];
  return (
    `${signature}\n` +
    `This letter is ${letter.body.length} characters long, too long to hand over here. ` +
    `Read it from the bridge: ${bridgeCommand} inbox --job ${letter.job}` +
    (bridgeHome ? ` --home ${shellQuote(bridgeHome)}` : '')
  );
}

/** A value as one word of a shell command line. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Waits `ms`. The timer does not keep the process alive. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
