#!/usr/bin/env node
/**
 * A stand-in for the Codex command line as far as the bridge adapters use it: `exec` with JSON
 * events, `queue`, the app-server daemon, `mcp` and `delete`. The commands `__open` and `__app`
 * exist only here and play the desktop app with its threads. The behaviour was measured on
 * codex-cli 0.167.0-alpha.4.1.
 *
 * MCP servers: a thread has the servers of `mcp add` and of `-c mcp_servers.<name>.*`. A server
 * is started outside the sandbox of the thread, with next to nothing of the environment and no
 * thread id in it: Codex names the thread in `_meta` of every tool call. A thread of `exec`
 * cannot ask anybody for an approval, so it calls only tools that say they destroy nothing and
 * stay in a closed world. The commands of a sandboxed thread reach no socket and write nowhere
 * outside their folder.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import {
  CliError,
  POLL_MS,
  Unsupported,
  abandonWork,
  awaitJson,
  boundLife,
  canonical,
  enqueue,
  flag,
  isAlive,
  isStateName,
  listRecords,
  listedIn,
  lock,
  onStopSignal,
  option,
  parseArgs,
  pending,
  performTurn,
  print,
  readJson,
  recordTurn,
  renderHelp,
  repeated,
  runCli,
  sandboxedEnv,
  sleep,
  spawnDetached,
  stateRoot,
  takeNext,
  terminate,
  tryLock,
  unlock,
  writeJson,
} from './lib.mjs';
import { envPairs, toolServers } from './mcp.mjs';

const SELF = fileURLToPath(import.meta.url);
const VERSION = '0.167.0-alpha.4.1';
const OWNER_KINDS = ['daemon', 'app'];
const THREAD_OWNERS = ['app', 'none'];
const TURN_STARTED = { type: 'turn.started' };
const TURN_COMPLETED = {
  type: 'turn.completed',
  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
};
const EXIT_ON_STOP_SIGNAL = 143;

const HELP_FLAGS = { '--help': flag('help'), '-h': flag('help') };
const FOLDER_FLAGS = { '-C': option('cd'), '--cd': option('cd') };
const EXEC_FLAGS = {
  ...HELP_FLAGS,
  ...FOLDER_FLAGS,
  '--json': flag('json'),
  '-s': option('sandbox'),
  '--sandbox': option('sandbox'),
  '--skip-git-repo-check': flag('skipGitRepoCheck'),
  '-m': option('model'),
  '--model': option('model'),
  '-c': repeated('config'),
  '--config': repeated('config'),
};
const MCP_ADD_FLAGS = { '--env': repeated('env') };
const MCP_JSON_FLAGS = { '--json': flag('json') };
/** What a server of tools gets of the environment of Codex: Codex gives it next to nothing */
const SERVER_ENV = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG'];
const NEEDS_APPROVAL = 'MCP tool call requires approval, but approval policy is never';
const QUEUE_FLAGS = {
  ...HELP_FLAGS,
  ...FOLDER_FLAGS,
  '--thread': option('thread'),
  '--message': option('message'),
  '--resume': flag('resume'),
};
const OPEN_FLAGS = {
  ...FOLDER_FLAGS,
  '--owner': option('owner'),
  '--sandbox': option('sandbox'),
};
const DELETE_FLAGS = { '--force': flag('force') };

const HELP = [
  'Codex CLI',
  '',
  'Usage: codex [OPTIONS] [PROMPT]',
  '       codex [OPTIONS] <COMMAND> [ARGS]',
  '',
  'Commands:',
  '  exec        Run Codex non-interactively',
  ['queue', '  queue       Queue a message for a thread'],
  '  app-server  Run the app server or its daemon',
  '  mcp         Manage external MCP servers for Codex',
  '  delete      Delete a thread',
  '',
  'Options:',
  '  -h, --help     Print help',
  '  -V, --version  Print version',
];

const EXEC_HELP = [
  'Run Codex non-interactively',
  '',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  '       codex exec resume <THREAD> [PROMPT]',
  '',
  'Options:',
  ['exec-json', '      --json                    Print events to stdout as JSONL'],
  '  -C, --cd <DIR>                The folder the agent works in',
  '  -s, --sandbox <SANDBOX_MODE>  The sandbox policy for the commands the model runs',
  '      --skip-git-repo-check     Allow running outside a Git repository',
  '  -m, --model <MODEL>           The model the agent uses',
  '  -c, --config <key=value>      Override a configuration value',
  '  -h, --help                    Print help',
];

const QUEUE_HELP = [
  'Queue a message for a thread',
  '',
  'Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>',
  '',
  'Options:',
  '      --thread <THREAD>  The thread that gets the message',
  '      --message <TEXT>   The text of the message',
  '      --resume           After queueing, try to resume the thread on the local daemon',
  '  -C, --cd <DIR>         The folder to look the thread up from',
  '  -h, --help             Print help',
];

const missing = () => listedIn('FAKE_CODEX_MISSING');
const version = () => process.env.FAKE_CODEX_VERSION || VERSION;
const threadsDir = () => join(stateRoot('codex'), 'threads');
const ownerFile = (kind) => join(stateRoot('codex'), `${kind}.json`);
const configFile = () => join(stateRoot('codex'), 'config.json');

function threadFiles(threadId) {
  const base = join(threadsDir(), threadId);
  return {
    record: `${base}.json`,
    transcript: `${base}.jsonl`,
    queue: `${base}.queue`,
    lock: `${base}.lock`,
    running: `${base}.pid`,
  };
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case '--version':
    case '-V':
      return print(`codex-cli ${version()}`);
    case '--help':
    case '-h':
      return print(renderHelp(HELP, missing()));
    case 'exec':
      return exec(rest);
    case 'queue':
      return queue(rest);
    case 'app-server':
      return appServer(rest);
    case 'mcp':
      return mcp(rest);
    case 'delete':
      return remove(rest);
    case '__open':
      return open(rest);
    case '__app':
      return ownerCommand('app', rest);
    case '__owner':
      return serve(rest);
    default:
      throw new Unsupported();
  }
}

async function exec(argv) {
  const { values, positionals } = parseArgs(argv, EXEC_FLAGS);
  if (values.help) return print(renderHelp(EXEC_HELP, missing()));
  if (values.json && missing().has('exec-json')) {
    throw new CliError("error: unexpected argument '--json' found", 2);
  }
  if (process.env.FAKE_CODEX_EXEC_FAIL) throw new CliError(process.env.FAKE_CODEX_EXEC_FAIL);
  const { resumed, promptArgument } = execTarget(positionals);
  const cwd = resumed ? undefined : workFolder(values.cd);
  const prompt = await promptText(promptArgument);
  const thread =
    resumed ??
    createThread({
      cwd,
      sandbox: values.sandbox ?? 'read-only',
      owner: 'none',
      servers: { ...configuredServers(), ...overriddenServers(values.config ?? []) },
    });
  await foregroundTurn(thread, prompt, values.json === true);
}

/** The MCP servers of the configuration, as `mcp add` left them */
function configuredServers() {
  return readJson(configFile(), {}).mcp_servers ?? {};
}

/**
 * The MCP servers `-c mcp_servers.<name>.<field>=<value>` describes. The values are TOML: a
 * string, an array of strings, or for `env` an inline table of strings.
 * @param {string[]} overrides
 */
function overriddenServers(overrides) {
  const servers = {};
  for (const override of overrides) {
    const match = /^mcp_servers\.([\w-]+)\.(command|args|env)=(.*)$/s.exec(override);
    if (!match) continue;
    const [, name, field, value] = match;
    servers[name] = { ...servers[name], [field]: tomlValue(field, value) };
  }
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) => typeof server.command === 'string')
  );
}

function tomlValue(field, value) {
  try {
    if (field !== 'env') return JSON.parse(value);
    const pairs = [...value.matchAll(/([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*")/g)];
    return Object.fromEntries(pairs.map(([, key, text]) => [key, JSON.parse(text)]));
  } catch {
    throw new CliError(`Error: invalid override value: ${value}`);
  }
}

/** Tells `exec <prompt>` from `exec resume <threadId> <prompt>` */
function execTarget(positionals) {
  const [first, ...rest] = positionals;
  if (first !== 'resume') {
    if (rest.length > 0) throw new Unsupported();
    return { promptArgument: first };
  }
  if (rest.length < 1 || rest.length > 2) throw new Unsupported();
  return { resumed: findThread(rest[0]), promptArgument: rest[1] };
}

function workFolder(dir) {
  const folder = canonical(dir ?? process.cwd());
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CliError(`Error: ${folder} is not a directory`);
  }
  return folder;
}

/** The prompt of `exec`: its argument, or stdin when the argument is `-` or absent */
async function promptText(argument) {
  const piped = argument === undefined || argument === '-';
  const prompt = piped ? (await text(process.stdin)).trimEnd() : argument;
  if (prompt.trim() === '') throw new CliError('No prompt provided');
  return prompt;
}

function createThread({ cwd, sandbox, owner, servers }) {
  const thread = { threadId: randomUUID(), cwd, sandbox, owner, servers, createdAt: Date.now() };
  writeJson(threadFiles(thread.threadId).record, thread);
  return thread;
}

function findThread(threadId) {
  const thread = isStateName(threadId) ? readJson(threadFiles(threadId).record) : undefined;
  if (thread === undefined) throw new CliError(`Error: no session found for '${threadId}'`);
  return thread;
}

/** Runs one turn of `exec` to its end. The first event leaves before the turn starts */
async function foregroundTurn(thread, prompt, asJson) {
  const { lock: lockFile, running } = threadFiles(thread.threadId);
  onStopSignal(async () => {
    rmSync(running, { force: true });
    await abandonWork();
    process.exit(EXIT_ON_STOP_SIGNAL);
  });
  await lock(lockFile);
  writeJson(running, { pid: process.pid });
  try {
    if (asJson) {
      await printEvents({ type: 'thread.started', thread_id: thread.threadId }, TURN_STARTED);
    }
    if (process.env.FAKE_CODEX_TURN_FAIL) throw new CliError(process.env.FAKE_CODEX_TURN_FAIL);
    const answer = await threadTurn(thread, prompt, 'exec');
    if (!asJson) return await print(answer);
    const item = { id: 'item_0', type: 'agent_message', text: answer };
    await printEvents({ type: 'item.completed', item }, TURN_COMPLETED);
  } finally {
    rmSync(running, { force: true });
    unlock(lockFile);
  }
}

async function printEvents(...events) {
  for (const event of events) await print(JSON.stringify(event));
}

/** One turn of a thread. The caller holds the lock of the thread */
async function threadTurn(thread, input, wokenBy) {
  const env = sandboxedEnv(
    {
      ...process.env,
      CODEX_THREAD_ID: thread.threadId,
      ...(thread.sandbox !== undefined && { FAKE_CODEX_SANDBOX: thread.sandbox }),
    },
    thread.sandbox,
    thread.cwd
  );
  const servers = toolServers(thread.servers ?? {}, {
    cwd: thread.cwd,
    envOf: (config) => ({
      ...Object.fromEntries(
        SERVER_ENV.flatMap((name) =>
          process.env[name] === undefined ? [] : [[name, process.env[name]]]
        )
      ),
      ...config.env,
    }),
    clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: version() },
  });
  const turnId = randomUUID();
  try {
    const outcome = await performTurn({
      input,
      cwd: thread.cwd,
      env,
      callTool: (server, tool, args) => callTool(thread, servers, turnId, server, tool, args),
    });
    recordTurn(threadFiles(thread.threadId).transcript, outcome, wokenBy);
    return outcome.answer;
  } finally {
    servers.close();
  }
}

/** Whether a tool says it changes nothing, or destroys nothing and stays in a closed world */
function isHarmless(annotations) {
  return (
    annotations?.readOnlyHint === true ||
    (annotations?.destructiveHint === false && annotations?.openWorldHint === false)
  );
}

/**
 * One tool call of a thread. A thread nobody sits at (`exec`) is refused a tool it would have
 * to ask about. The thread is named in `_meta`, the only place a server learns it from.
 */
async function callTool(thread, servers, turnId, serverName, toolName, args) {
  const found = await servers.get(serverName);
  if (!found) return { text: `unknown MCP server '${serverName}'`, isError: true };
  const tool = found.tools.find(({ name }) => name === toolName);
  if (!tool) return { text: `unknown tool '${toolName}' of '${serverName}'`, isError: true };
  if (thread.owner === 'none' && !isHarmless(tool.annotations)) {
    return { text: NEEDS_APPROVAL, isError: true };
  }
  const { threadId } = thread;
  return found.server.call(toolName, args, {
    callId: `exec-${randomUUID()}`,
    'x-codex-turn-metadata': {
      session_id: threadId,
      thread_id: threadId,
      turn_id: turnId,
      sandbox_mode: thread.sandbox ?? 'danger-full-access',
      codex_version: version(),
    },
    threadId,
    sessionId: threadId,
    progressToken: 1,
  });
}

async function open(argv) {
  const { values, positionals } = parseArgs(argv, OPEN_FLAGS);
  const owner = values.owner ?? 'app';
  if (positionals.length > 0 || !THREAD_OWNERS.includes(owner)) throw new Unsupported();
  const thread = createThread({
    cwd: workFolder(values.cd),
    sandbox: values.sandbox,
    owner,
    servers: configuredServers(),
  });
  await print(thread.threadId);
}

/** `mcp add`, `get`, `list` and `remove`: the servers every new thread gets */
async function mcp(argv) {
  const [action, ...rest] = argv;
  const servers = configuredServers();
  const save = () => writeJson(configFile(), { mcp_servers: servers });
  const shown = (name) => ({
    name,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: servers[name].command,
      args: servers[name].args ?? [],
      env: servers[name].env ?? null,
      env_vars: [],
      cwd: null,
    },
  });
  if (action === 'add') {
    const { values, positionals } = parseArgs(rest, MCP_ADD_FLAGS);
    const [name, command, ...args] = positionals;
    const env = envPairs(values.env ?? []);
    if (name === undefined || command === undefined || env === undefined) throw new Unsupported();
    servers[name] = { command, args, ...(Object.keys(env).length > 0 && { env }) };
    save();
    return print(`Added global MCP server '${name}'.`);
  }
  const { values, positionals } = parseArgs(rest, MCP_JSON_FLAGS);
  const [name] = positionals;
  if (action === 'list' && positionals.length === 0) {
    const all = Object.keys(servers).map(shown);
    return print(values.json ? JSON.stringify(all, null, 2) : all.map((s) => s.name).join('\n'));
  }
  if (positionals.length !== 1) throw new Unsupported();
  const known = Object.hasOwn(servers, name);
  if (action === 'get') {
    if (!known) throw new CliError(`Error: No MCP server named '${name}' found.`);
    const { transport } = shown(name);
    return print(
      values.json
        ? JSON.stringify(shown(name), null, 2)
        : `${name}\n  enabled: true\n  transport: stdio\n  command: ${transport.command}\n  args: ${transport.args.join(' ')}`
    );
  }
  if (action !== 'remove') throw new Unsupported();
  if (!known) return print(`No MCP server named '${name}' found.`);
  delete servers[name];
  save();
  return print(`Removed global MCP server '${name}'.`);
}

async function queue(argv) {
  if (missing().has('queue')) throw new CliError("error: unrecognized subcommand 'queue'", 2);
  const { values, positionals } = parseArgs(argv, QUEUE_FLAGS);
  if (values.help) return print(renderHelp(QUEUE_HELP, missing()));
  const { thread: threadId, message } = values;
  if (threadId === undefined || message === undefined || positionals.length > 0) {
    throw new Unsupported();
  }
  findThread(threadId);
  const messageId = randomUUID();
  enqueue(threadFiles(threadId).queue, { text: message });
  await print(`Queued message ${messageId} for thread ${threadId}.`);
  if (values.resume && !isOwnerAlive('daemon')) {
    process.stderr.write(
      `Warning: message was queued, but could not resume thread ${threadId}: ` +
        'start a local daemon or specify a server with --remote\n'
    );
  }
}

function isOwnerAlive(kind) {
  const pid = readJson(ownerFile(kind))?.pid;
  return pid !== undefined && isAlive(pid);
}

async function appServer(argv) {
  const [group, ...rest] = argv;
  if (group !== 'daemon') throw new Unsupported();
  if (rest.length === 1 && rest[0] === 'version') return daemonVersion();
  return ownerCommand('daemon', rest);
}

async function daemonVersion() {
  if (!isOwnerAlive('daemon')) {
    const socket = join(stateRoot('codex'), 'app-server-control', 'app-server-control.sock');
    throw new CliError(`Error: failed to connect to ${socket}`);
  }
  await print(JSON.stringify({ cliVersion: version(), appServerVersion: version() }));
}

/** `start` or `stop` of the daemon, or of the stand-in of the desktop app */
async function ownerCommand(kind, argv) {
  const [action] = argv;
  if (argv.length !== 1 || !['start', 'stop'].includes(action)) throw new Unsupported();
  await print(action === 'start' ? startOwner(kind) : await stopOwner(kind));
}

function startOwner(kind) {
  if (isOwnerAlive(kind)) return 'already running';
  writeJson(ownerFile(kind), { pid: spawnDetached(SELF, ['__owner', kind]) });
  return 'started';
}

async function stopOwner(kind) {
  const running = isOwnerAlive(kind);
  if (running) await terminate(readJson(ownerFile(kind)).pid);
  rmSync(ownerFile(kind), { force: true });
  return running ? 'stopped' : 'not running';
}

/**
 * An owner process: runs the queued messages of the threads it serves, each message as one
 * turn. The daemon serves every thread, the app only the threads it owns.
 */
async function serve(argv) {
  const [kind] = argv;
  if (argv.length !== 1 || !OWNER_KINDS.includes(kind)) throw new Unsupported();
  if ((await awaitJson(ownerFile(kind))) === undefined) return;
  boundLife(ownerFile(kind), async () => {
    await abandonWork();
    process.exit(0);
  });
  const draining = new Set();
  for (;;) {
    for (const thread of listRecords(threadsDir())) {
      const { threadId, owner } = thread;
      if ((kind === 'app' && owner !== 'app') || draining.has(threadId)) continue;
      draining.add(threadId);
      void drain(thread).finally(() => draining.delete(threadId));
    }
    await sleep(POLL_MS);
  }
}

/**
 * Runs what waits in the queue of a thread, in order. The lock keeps it to one turn at a time
 * per thread when the daemon, the app and `exec resume` meet on it.
 */
async function drain(thread) {
  const files = threadFiles(thread.threadId);
  if (pending(files.queue).length === 0 || !tryLock(files.lock)) return;
  try {
    for (let message = takeNext(files.queue); message; message = takeNext(files.queue)) {
      await threadTurn(thread, message.text, 'queue');
    }
  } finally {
    unlock(files.lock);
  }
}

async function remove(argv) {
  const { values, positionals } = parseArgs(argv, DELETE_FLAGS);
  const [threadId] = positionals;
  if (positionals.length !== 1) throw new Unsupported();
  if (!values.force) throw new CliError(`error: deleting thread ${threadId} needs --force`, 2);
  findThread(threadId);
  const files = threadFiles(threadId);
  await lock(files.lock);
  rmSync(files.record, { force: true });
  rmSync(files.transcript, { force: true });
  rmSync(files.queue, { recursive: true, force: true });
  rmSync(files.running, { force: true });
  unlock(files.lock);
}

await runCli('codex', main);
