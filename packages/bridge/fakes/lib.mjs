/**
 * Shared code of the fake `claude` and `codex` executables the bridge tests run in place of the
 * real command lines: state guarded by FAKE_HARNESS_HOME, atomic files, message spools, locks,
 * child shells, the scripted model and the life cycle of the processes a fake leaves running.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };

/** How often a fake looks again at a spool, a lock or a process it waits for */
export const POLL_MS = 25;

const RUN_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const DEFAULT_MAX_LIFE_MS = 120_000;
const STATE_WATCH_MS = 100;
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'];

/** A failure the command reports on stderr together with its exit code */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Arguments a fake does not imitate, reported with exit code 64 */
export class Unsupported extends Error {}

/**
 * The folder one fake keeps its state in. Throws without FAKE_HARNESS_HOME, so that a fake never
 * touches a real `~/.claude` or `~/.codex`.
 * @param {string} name `claude` or `codex`
 */
export function stateRoot(name) {
  const home = process.env.FAKE_HARNESS_HOME;
  if (!home) {
    throw new CliError(
      `fake ${name}: FAKE_HARNESS_HOME is not set, refusing to touch a real home folder`,
      2
    );
  }
  return resolve(home, name);
}

/**
 * Runs a command of a fake. Failures end up on stderr with their exit code, and the process ends
 * by itself afterwards, so that everything written reaches a reader on a pipe.
 * @param {string} name `claude` or `codex`
 * @param {(argv: string[]) => Promise<void>} main
 */
export async function runCli(name, main) {
  const argv = process.argv.slice(2);
  try {
    stateRoot(name);
    await main(argv);
  } catch (error) {
    const failure =
      error instanceof Unsupported
        ? new CliError(`fake ${name}: unsupported: ${argv.join(' ')}`, 64)
        : error;
    if (!(failure instanceof CliError)) throw failure;
    process.stderr.write(`${failure.message}\n`);
    process.exitCode = failure.code;
  }
}

/**
 * Writes a line to stdout and resolves once it left the process: a reader sees it before
 * anything that happens next.
 * @param {string} text
 */
export function print(text) {
  return new Promise((done) => process.stdout.write(`${text}\n`, () => done()));
}

/** @typedef {{ key: string, takesValue: boolean, repeats?: boolean }} Flag */

/** @param {string} key @returns {Flag} */
export const flag = (key) => ({ key, takesValue: false });

/** @param {string} key @returns {Flag} */
export const option = (key) => ({ key, takesValue: true });

/** An option that may be given several times: its values come as an array. @param {string} key @returns {Flag} */
export const repeated = (key) => ({ key, takesValue: true, repeats: true });

/**
 * Splits arguments into option values and positionals. An option that takes a value consumes
 * the next argument whatever it looks like, `--name=value` works for long names, `--` ends the
 * options and a lone `-` is a positional. An unknown option is {@link Unsupported}.
 * @param {string[]} argv
 * @param {Record<string, Flag>} flags by the name on the command line, such as `--json` or `-C`
 * @returns {{ values: Record<string, string | string[] | true>, positionals: string[] }}
 */
export function parseArgs(argv, flags) {
  const values = {};
  const positionals = [];
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--') positionals.push(...rest.splice(0));
    else if (arg === '-' || !arg.startsWith('-')) positionals.push(arg);
    else {
      const { key, value, repeats } = readOption(arg, rest, flags);
      if (repeats) (values[key] ??= []).push(value);
      else values[key] = value;
    }
  }
  return { values, positionals };
}

function readOption(arg, rest, flags) {
  const cut = arg.startsWith('--') ? arg.indexOf('=') : -1;
  const name = cut === -1 ? arg : arg.slice(0, cut);
  const inline = cut === -1 ? undefined : arg.slice(cut + 1);
  if (!Object.hasOwn(flags, name)) throw new Unsupported();
  const { key, takesValue, repeats } = flags[name];
  if (!takesValue) {
    if (inline !== undefined) throw new Unsupported();
    return { key, value: true };
  }
  const value = inline ?? rest.shift();
  if (value === undefined) throw new Unsupported();
  return { key, value, repeats };
}

/**
 * The comma list of an environment variable such as FAKE_CLAUDE_MISSING.
 * @param {string} variable
 * @returns {Set<string>}
 */
export function listedIn(variable) {
  const items = (process.env[variable] ?? '').split(',').map((item) => item.trim());
  return new Set(items.filter(Boolean));
}

/**
 * A help text without the lines of the features an imitated old version lacks.
 * @param {(string | [feature: string, line: string])[]} lines
 * @param {Set<string>} missing
 */
export function renderHelp(lines, missing) {
  return lines
    .filter((line) => typeof line === 'string' || !missing.has(line[0]))
    .map((line) => (typeof line === 'string' ? line : line[1]))
    .join('\n');
}

/** @param {string} path the absolute path with links resolved, as `process.cwd()` reports it */
export function canonical(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** @returns {boolean} whether `folder` is `parent` or lies below it */
export function isWithin(folder, parent) {
  const hops = relative(canonical(parent), canonical(folder));
  return hops !== '..' && !hops.startsWith(`..${sep}`);
}

/** @returns {boolean} whether an id is safe as a file name inside a state folder */
export function isStateName(id) {
  return /^[\w-]+$/.test(id);
}

function unlessMissing(read, fallback) {
  try {
    return read();
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** @returns the parsed file, or `fallback` when it does not exist */
export function readJson(file, fallback) {
  return unlessMissing(() => JSON.parse(readFileSync(file, 'utf8')), fallback);
}

/** Replaces a state file in one step: readers see the old content or the new, never a part */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(value, null, 2));
  renameSync(draft, file);
}

/**
 * Merges fields into a state file, `undefined` drops a field. A file that is gone stays gone.
 * @returns the new content, or `undefined` when the file does not exist
 */
export function patchJson(file, patch) {
  const current = readJson(file);
  if (current === undefined) return undefined;
  const next = { ...current, ...patch };
  writeJson(file, next);
  return next;
}

/** @returns {object[]} every record (`*.json`) of a state folder */
export function listRecords(dir) {
  return unlessMissing(() => readdirSync(dir), [])
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(join(dir, name)))
    .filter((record) => record !== undefined);
}

/** Resolves with a record another process is about to write, or `undefined` when it never comes */
export async function awaitJson(file) {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_MS);
  }
  return readJson(file);
}

let enqueued = 0;

/**
 * Adds a message to a spool folder as one file. Names sort by arrival time, a message shows up
 * under its name only when it is complete.
 */
export function enqueue(dir, message) {
  mkdirSync(dir, { recursive: true });
  const stamp = [Date.now(), process.pid, enqueued++].map((part) => String(part).padStart(15, '0'));
  const name = `${stamp.join('-')}.json`;
  writeFileSync(join(dir, `.${name}`), JSON.stringify(message));
  renameSync(join(dir, `.${name}`), join(dir, name));
}

/** @returns {string[]} the names of the messages waiting in a spool folder, oldest first */
export function pending(dir) {
  return unlessMissing(() => readdirSync(dir), [])
    .filter((name) => !name.startsWith('.'))
    .sort();
}

/**
 * Takes the oldest message out of a spool folder. It is renamed away first, so no message is
 * taken twice even when several processes look at one folder.
 * @returns the message, or `undefined` when nothing waits
 */
export function takeNext(dir) {
  const [name] = pending(dir);
  if (name === undefined) return undefined;
  const taken = join(dir, `.taken-${process.pid}-${name}`);
  return unlessMissing(() => {
    renameSync(join(dir, name), taken);
    const message = JSON.parse(readFileSync(taken, 'utf8'));
    rmSync(taken);
    return message;
  }, undefined);
}

/** Lock files this process holds, released when it stops */
const heldLocks = new Set();

/**
 * Tries to take a lock file. The file appears with the pid of its holder already in it, and a
 * lock whose holder died is cleared for the next attempt.
 * @returns {boolean} whether this process holds the lock now
 */
export function tryLock(file) {
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, String(process.pid));
  try {
    linkSync(draft, file);
    heldLocks.add(file);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    clearStaleLock(file);
    return false;
  } finally {
    rmSync(draft, { force: true });
  }
}

function clearStaleLock(file) {
  const holder = unlessMissing(() => Number(readFileSync(file, 'utf8')), undefined);
  if (holder !== undefined && !isAlive(holder)) rmSync(file, { force: true });
}

/** Waits for a lock file however long its holder keeps it */
export async function lock(file) {
  while (!tryLock(file)) await sleep(POLL_MS);
}

export function unlock(file) {
  heldLocks.delete(file);
  rmSync(file, { force: true });
}

/** @returns {boolean} whether a process with this pid exists */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function send(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
}

async function isGone(pid) {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** Asks a process to stop and waits until it is gone, killing it when it does not listen */
export async function terminate(pid) {
  send(pid, 'SIGTERM');
  if (await isGone(pid)) return;
  send(pid, 'SIGKILL');
  await isGone(pid);
}

/**
 * Starts a script of a fake as a process that outlives the command, with the environment and
 * the folder of the command.
 * @returns {number} its pid
 */
export function spawnDetached(script, args) {
  const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

function maxLifeMs() {
  const value = Number(process.env.FAKE_HARNESS_MAX_LIFE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LIFE_MS;
}

/** Calls `stop` when the process is asked to end */
export function onStopSignal(stop) {
  for (const signal of STOP_SIGNALS) process.on(signal, stop);
}

/**
 * Keeps a long-lived process from outliving a test run: `stop` is called on a stop signal, after
 * FAKE_HARNESS_MAX_LIFE_MS and when the state file of the process is removed.
 */
export function boundLife(stateFile, stop) {
  onStopSignal(stop);
  setTimeout(stop, maxLifeMs());
  setInterval(() => {
    if (!existsSync(stateFile)) stop();
  }, STATE_WATCH_MS);
}

/** Child shells of this process that still run */
const shells = new Set();

function signalGroup(pid, signal) {
  if (pid !== undefined) send(-pid, signal);
}

/**
 * @typedef {object} ShellResult
 * @property {number | null} code `null` when a signal ended the shell or it never started
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

/**
 * Starts `sh -c <command>` in a process group of its own, so that a kill reaches whatever the
 * command started.
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} options.env
 * @param {number} options.timeoutMs
 * @param {NodeJS.Signals} options.killSignal sent to the group when the time is up
 * @param {string} [options.input] written to stdin, which is then closed
 * @returns {{ pid: number | undefined, done: Promise<ShellResult> }}
 */
export function startShell(command, { cwd, env, timeoutMs, killSignal, input }) {
  const child = spawn('sh', ['-c', command], {
    cwd,
    env,
    detached: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  shells.add(child);
  const done = new Promise((settle) => {
    const output = { stdout: '', stderr: '' };
    let timedOut = false;
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8').on('data', (chunk) => (output[stream] += chunk));
    }
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, killSignal);
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      shells.delete(child);
      settle({ code, ...output, timedOut });
    };
    child.on('error', (error) => {
      output.stderr += error.message;
      finish(null);
    });
    child.on('close', finish);
  });
  if (input !== undefined) {
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  }
  return { pid: child.pid, done };
}

/** Ends what this process still has going before it stops: its child shells and its locks */
export function abandonWork() {
  for (const child of shells) signalGroup(child.pid, 'SIGTERM');
  for (const file of [...heldLocks]) unlock(file);
}

/** @typedef {{ command: string, code: number | null, stdout: string, stderr: string }} CommandRun */

/**
 * A tool call of a turn: `args` as the model wrote them, `sent` as they reached the server when
 * a hook changed them
 * @typedef {{ tool: string, args: Record<string, unknown>, sent?: Record<string, unknown>, text: string, isError: boolean }} ToolRun
 */

/** @typedef {{ at: string, input: string, ran: CommandRun[], tools: ToolRun[], answer: string }} TurnOutcome */

/** @typedef {(server: string, tool: string, args: Record<string, unknown>) => Promise<{ text: string, isError: boolean, sent?: Record<string, unknown> }>} ToolCaller */

/**
 * The directives of an input, in the order of its lines. A line counts after its leading
 * whitespace is trimmed, a quoted line (`> run: ...`) is not a directive.
 * @returns {{ kind: 'run' | 'sleep' | 'say' | 'tool', value: string }[]}
 */
function directives(input) {
  return input.split(/\r?\n/).flatMap((line) => {
    const match = /^(run|sleep|say|tool): (.+)$/.exec(line.trimStart());
    if (!match) return [];
    const [, kind, text] = match;
    const value = text.trim();
    return kind === 'sleep' && !/^\d+$/.test(value) ? [] : [{ kind, value }];
  });
}

async function runCommand(command, cwd, env) {
  const shell = startShell(command, { cwd, env, timeoutMs: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const { code, stdout, stderr } = await shell.done;
  return { command, code, stdout, stderr };
}

/**
 * A `tool:` directive: `<server>.<tool>` and then the arguments as one JSON object, or nothing.
 * A line that does not read as one calls nothing and is recorded as a failed call.
 * @param {string} value
 * @param {ToolCaller | undefined} callTool
 * @returns {Promise<ToolRun>}
 */
async function runTool(value, callTool) {
  const match = /^([\w-]+)\.([\w-]+)(?:\s+(\{.*\}))?$/.exec(value);
  const failed = (text) => ({ tool: value.split(/\s/, 1)[0], args: {}, text, isError: true });
  if (!match) return failed('not a tool call: expected <server>.<tool> {json}');
  const [, server, tool, json] = match;
  let args;
  try {
    args = json === undefined ? {} : JSON.parse(json);
  } catch {
    return failed('the arguments of the tool call are not JSON');
  }
  if (!callTool) return { ...failed('this session has no MCP servers'), args };
  try {
    return { tool: `${server}.${tool}`, args, ...(await callTool(server, tool, args)) };
  } catch (error) {
    return { tool: `${server}.${tool}`, args, text: error.message, isError: true };
  }
}

/**
 * The scripted model: runs every `run: <command>` line with `sh -c`, calls the tool of every
 * `tool: <server>.<tool> {json}` line and waits out every `sleep: <ms>` line, one after another,
 * and answers with the last `say: <text>` line, or `ok`.
 * @param {object} turn
 * @param {string} turn.input
 * @param {string} turn.cwd where the commands run
 * @param {NodeJS.ProcessEnv} turn.env what the commands see
 * @param {ToolCaller} [turn.callTool] how the session calls a tool of one of its MCP servers
 * @returns {Promise<TurnOutcome>}
 */
export async function performTurn({ input, cwd, env, callTool }) {
  const at = new Date().toISOString();
  const ran = [];
  const tools = [];
  let answer = 'ok';
  for (const { kind, value } of directives(input)) {
    if (kind === 'run') ran.push(await runCommand(value, cwd, env));
    else if (kind === 'tool') tools.push(await runTool(value, callTool));
    else if (kind === 'sleep') await sleep(Number(value));
    else answer = value;
  }
  return { at, input, ran, tools, answer };
}

/**
 * The environment of the commands of a sandboxed session: the fake sandbox is loaded into every
 * Node process among them. No sandbox, no change.
 * @param {NodeJS.ProcessEnv} env
 * @param {string | undefined} mode `read-only`, `workspace-write` or `danger-full-access`
 * @param {string} root the folder the session may write to
 */
export function sandboxedEnv(env, mode, root) {
  if (mode === undefined || mode === 'danger-full-access') return env;
  const preload = `--import ${new URL('./sandbox.mjs', import.meta.url).href}`;
  return {
    ...env,
    NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload,
    FAKE_SANDBOX: mode,
    FAKE_SANDBOX_ROOT: root,
  };
}

function countLines(file) {
  return unlessMissing(() => readFileSync(file, 'utf8'), '').split('\n').length - 1;
}

/**
 * Appends a finished turn to a transcript as one JSON line.
 * @param {string} transcript
 * @param {TurnOutcome} outcome
 * @param {'prompt' | 'user' | 'hook' | 'queue' | 'exec'} wokenBy what started the turn
 */
export function recordTurn(transcript, { at, input, ran, tools, answer }, wokenBy) {
  const turn = { turn: countLines(transcript) + 1, at, input, ran, tools, answer, wokenBy };
  appendFileSync(transcript, `${JSON.stringify(turn)}\n`);
}
