#!/usr/bin/env node
/**
 * A stand-in for the Claude Code command line as far as the bridge adapters use it: background
 * sessions, their listing, Stop hooks with rewake, `mcp`, `stop` and `rm`. The commands `__open`
 * and `__say` exist only here and play a person at an open window. The behaviour was measured
 * on Claude Code 2.1.292 and 2.1.325.
 *
 * MCP servers: a session has the servers of `--mcp-config` and of `mcp add` (local, project and
 * user scope). A server is started once for the session, with the environment of the session
 * and the id the session had then. Before a tool call the `PreToolUse` hooks whose matcher fits
 * `mcp__<server>__<tool>` run, and one may replace the arguments (`updatedInput`). A background
 * session calls only the tools its settings allow: nobody sits there to be asked.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliError,
  POLL_MS,
  Unsupported,
  abandonWork,
  awaitJson,
  boundLife,
  enqueue,
  flag,
  isAlive,
  isStateName,
  isWithin,
  listRecords,
  listedIn,
  option,
  parseArgs,
  patchJson,
  performTurn,
  print,
  readJson,
  recordTurn,
  renderHelp,
  repeated,
  runCli,
  sleep,
  spawnDetached,
  startShell,
  stateRoot,
  takeNext,
  terminate,
  writeJson,
} from './lib.mjs';
import { envPairs, toolServers } from './mcp.mjs';

const SELF = fileURLToPath(import.meta.url);
const VERSION = '2.1.292';
const DEFAULT_HOOK_TIMEOUT_S = 600;
const NOT_TRUSTED =
  'Workspace not trusted. Run claude once in this folder and accept the trust prompt';

const OPEN_FLAGS = {
  '--settings': option('settings'),
  '--mcp-config': option('mcpConfig'),
  '-n': option('name'),
  '--name': option('name'),
};
const START_FLAGS = {
  ...OPEN_FLAGS,
  '--bg': flag('bg'),
  '--background': flag('bg'),
  '--permission-mode': option('permissionMode'),
  '--model': option('model'),
  '--append-system-prompt': option('appendSystemPrompt'),
  '--add-dir': option('addDir'),
};
const AGENTS_FLAGS = {
  '--json': flag('json'),
  '--all': flag('all'),
  '--cwd': option('cwd'),
  '--help': flag('help'),
  '-h': flag('help'),
};

const MCP_FLAGS = {
  '-s': option('scope'),
  '--scope': option('scope'),
  '-e': repeated('env'),
  '--env': repeated('env'),
};
const MCP_SCOPES = ['local', 'project', 'user'];
const HOOK_TIMEOUT_S = 60;

/** What FAKE_CLAUDE_MISSING can take away from the options that start a session */
const REMOVABLE_START_OPTIONS = [
  ['bg', '--bg'],
  ['settings', '--settings'],
];

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Claude Code - starts an interactive session by default',
  '',
  'Options:',
  ['bg', '  --bg, --background             Start the session in the background and return'],
  ['settings', '  --settings <file-or-json>      A settings JSON file or a JSON string to load'],
  '  --mcp-config <file-or-json>    MCP servers to load from a JSON file or string',
  '  -n, --name <name>              Set a display name for the session',
  '  --permission-mode <mode>       Permission mode to use for the session',
  '  --model <model>                Model for the session',
  '  --append-system-prompt <text>  Append text to the default system prompt',
  '  --add-dir <dir>                An additional folder to allow tool access to',
  '  -v, --version                  Output the version number',
  '  -h, --help                     Display help for command',
  '',
  'Commands:',
  '  agents [options]               List sessions',
  '  mcp                            Configure and manage MCP servers',
  '  attach <id>                    Attach to a background session',
  '  stop <id>                      Stop a session',
  '  rm <id>                        Remove a session',
];

const AGENTS_HELP = [
  'Usage: claude agents [options]',
  '',
  'List sessions',
  '',
  'Options:',
  ['agents-json', '  --json        Print the sessions as a JSON array'],
  '  --all         Include stopped sessions',
  '  --cwd <path>  Only sessions in this folder or below it',
  '  -h, --help    Display help for command',
];

const missing = () => listedIn('FAKE_CLAUDE_MISSING');
const trustedFile = () => join(stateRoot('claude'), 'trusted.json');
const sessionsDir = () => join(stateRoot('claude'), 'sessions');
/** The file Claude Code keeps a person's configuration in, `.claude.json` */
const configFile = () =>
  join(process.env.CLAUDE_CONFIG_DIR?.trim() || stateRoot('claude'), '.claude.json');

/** The state paths of a session. An id that could lead out of the sessions folder is refused */
function sessionFiles(sessionId) {
  if (!isStateName(sessionId)) throw new Unsupported();
  const base = join(sessionsDir(), sessionId);
  return { record: `${base}.json`, transcript: `${base}.jsonl`, spool: `${base}.in` };
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case '--version':
    case '-v':
      return print(`${process.env.FAKE_CLAUDE_VERSION || VERSION} (Claude Code)`);
    case '--help':
    case '-h':
      return print(renderHelp(HELP, missing()));
    case 'agents':
      return agents(rest);
    case 'mcp':
      return mcp(rest);
    case 'stop':
      return stop(rest);
    case 'rm':
      return remove(rest);
    case '__open':
      return open(rest);
    case '__say':
      return say(rest);
    case '__session':
      return runSession(rest);
    default:
      return background(argv);
  }
}

async function background(argv) {
  const { values, positionals } = parseArgs(argv, START_FLAGS);
  const [prompt] = positionals;
  if (!values.bg || positionals.length !== 1 || prompt.trim() === '') throw new Unsupported();
  for (const [feature, name] of REMOVABLE_START_OPTIONS) {
    if (missing().has(feature) && values[feature] !== undefined) {
      throw new CliError(`error: unknown option '${name}'`);
    }
  }
  if (process.env.FAKE_CLAUDE_BG_FAIL) throw new CliError(process.env.FAKE_CLAUDE_BG_FAIL);
  if (!isTrusted(process.cwd())) throw new CliError(NOT_TRUSTED);
  const session = startSession({
    kind: 'background',
    name: values.name ?? defaultName(prompt),
    settings: values.settings,
    mcpConfig: values.mcpConfig,
    permissionMode: values.permissionMode,
    prompt,
  });
  await print(`backgrounded · ${session.id} · ${session.name}`);
}

async function open(argv) {
  const { values, positionals } = parseArgs(argv, OPEN_FLAGS);
  if (positionals.length > 0) throw new Unsupported();
  const session = startSession({
    kind: 'interactive',
    name: values.name,
    settings: values.settings,
    mcpConfig: values.mcpConfig,
  });
  await print(session.sessionId);
}

function isTrusted(folder) {
  return readJson(trustedFile(), []).some((trusted) => isWithin(folder, trusted));
}

function defaultName(prompt) {
  return prompt.trim().split(/\s+/).slice(0, 3).join('-').toLowerCase();
}

/**
 * Writes the record of a new session and starts its process. A background session begins busy
 * with its prompt, an interactive one sits idle until somebody types.
 */
function startSession({ kind, name, settings, mcpConfig, permissionMode, prompt }) {
  checkSettings(settings);
  checkSettings(mcpConfig, '--mcp-config');
  const sessionId = randomUUID();
  const files = sessionFiles(sessionId);
  const inBackground = kind === 'background';
  if (prompt !== undefined) enqueue(files.spool, { wokenBy: 'prompt', text: prompt });
  const record = {
    ...(inBackground && { id: shortId(sessionId) }),
    sessionId,
    name,
    cwd: process.cwd(),
    kind,
    startedAt: Date.now(),
    pid: spawnDetached(SELF, ['__session', sessionId]),
    status: inBackground ? 'busy' : 'idle',
    ...(inBackground && { state: 'working' }),
    settings,
    mcpConfig,
    permissionMode,
  };
  writeJson(files.record, record);
  return record;
}

const shortId = (sessionId) => sessionId.slice(0, 8);

/** The value of `--settings`: a JSON string, or the path of a JSON file */
function readSettingsOption(value, cwd) {
  const json = value.trimStart().startsWith('{')
    ? value
    : readFileSync(resolve(cwd, value), 'utf8');
  return JSON.parse(json);
}

function checkSettings(value, option = '--settings') {
  if (value === undefined) return;
  try {
    readSettingsOption(value, process.cwd());
  } catch (error) {
    throw new CliError(`Error: cannot load ${option}: ${error.message}`);
  }
}

/**
 * What a session inherits from the command that started it. Claude Code does not promise a
 * background session the environment of `claude --bg`: with FAKE_CLAUDE_BG_CLEAN_ENV set the
 * fake keeps only what a service started on its own would have, so a test can prove that
 * nothing depends on more.
 */
function sessionBaseEnv() {
  if (!process.env.FAKE_CLAUDE_BG_CLEAN_ENV) return process.env;
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => ['PATH', 'HOME', 'TMPDIR'].includes(name) || name.startsWith('FAKE_')
    )
  );
}

/**
 * The session process: takes the prompt, typed messages and hook wake-ups in the order they
 * arrived, runs a turn for each and fires the Stop hooks after it.
 */
async function runSession(argv) {
  const [sessionId] = argv;
  if (argv.length !== 1) throw new Unsupported();
  const files = sessionFiles(sessionId);
  const record = await awaitJson(files.record);
  if (record === undefined) return;
  const env = {
    ...sessionBaseEnv(),
    CLAUDE_CODE_SESSION_ID: sessionId,
    CLAUDE_PROJECT_DIR: record.cwd,
  };
  const session = { record, files, env, hookPids: new Set() };
  const servers = toolServers(sessionServers(record), {
    cwd: record.cwd,
    envOf: (config) => ({ ...env, ...config.env }),
    clientInfo: { name: 'claude-code', title: 'Claude Code', version: VERSION },
  });
  boundLife(files.record, () => {
    servers.close();
    endSession(files.record);
  });
  for (;;) {
    const message = await nextMessage(files.spool);
    setActivity(session, 'busy');
    const outcome = await performTurn({
      input: message.text,
      cwd: record.cwd,
      env,
      callTool: (server, tool, args) => callTool(session, servers, server, tool, args),
    });
    setActivity(session, 'idle');
    recordTurn(files.transcript, outcome, message.wokenBy);
    await fireStopHooks(session, outcome.answer, message.wokenBy === 'hook');
  }
}

/**
 * The MCP servers of a session: those of `mcp add` for every project (user scope), of the
 * project's `.mcp.json` and of this person in the project (local scope), from the folder of the
 * session up, and those of `--mcp-config` over them all.
 */
function sessionServers(record) {
  const config = readJson(configFile(), {});
  const servers = { ...config.mcpServers };
  const folders = [];
  for (let dir = record.cwd; ; dir = dirname(dir)) {
    folders.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  for (const dir of folders) {
    Object.assign(servers, readJson(join(dir, '.mcp.json'), {}).mcpServers);
    Object.assign(servers, config.projects?.[dir]?.mcpServers);
  }
  if (record.mcpConfig !== undefined) {
    Object.assign(servers, readSettingsOption(record.mcpConfig, record.cwd).mcpServers);
  }
  return servers;
}

/** The settings a session goes by: `--settings` and the two settings files of its project */
function settingsOf(record) {
  const project = join(record.cwd, '.claude');
  const sources = [
    () => record.settings && readSettingsOption(record.settings, record.cwd),
    () => readJson(join(project, 'settings.json')),
    () => readJson(join(project, 'settings.local.json')),
  ];
  return sources.flatMap((read) => {
    try {
      const settings = read();
      return settings ? [settings] : [];
    } catch {
      return [];
    }
  });
}

function isAllowed(record, toolName, serverName) {
  const allowed = settingsOf(record).flatMap((settings) => settings.permissions?.allow ?? []);
  const rules = [toolName, `mcp__${serverName}`, `mcp__${serverName}__*`];
  return allowed.some((rule) => rules.includes(rule));
}

/**
 * One tool call of a session: the permission of the session, the `PreToolUse` hooks that match
 * the tool, then the call with the arguments the hooks left.
 */
async function callTool(session, servers, serverName, toolName, args) {
  const { record, files } = session;
  const found = await servers.get(serverName);
  if (!found) return { text: `No MCP server named "${serverName}"`, isError: true };
  if (!found.tools.some(({ name }) => name === toolName)) {
    return { text: `No such tool available: mcp__${serverName}__${toolName}`, isError: true };
  }
  const name = `mcp__${serverName}__${toolName}`;
  if (record.kind === 'background' && !isAllowed(record, name, serverName)) {
    return {
      text: `Claude requested permissions to use ${name}, but you haven't granted it yet.`,
      isError: true,
    };
  }
  const toolUseId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  let input = args;
  for (const { matcher, hook } of toolHooks(record)) {
    if (!new RegExp(`^(?:${matcher})$`).test(name)) continue;
    const payload = JSON.stringify({
      session_id: record.sessionId,
      transcript_path: files.transcript,
      cwd: record.cwd,
      permission_mode: record.permissionMode ?? 'default',
      hook_event_name: 'PreToolUse',
      tool_name: name,
      tool_input: input,
      tool_use_id: toolUseId,
    });
    const result = await runHook(session, { timeout: HOOK_TIMEOUT_S, ...hook }, payload);
    if (result.code === 2) return { text: result.stderr.trim(), isError: true };
    if (result.code !== 0) continue;
    try {
      const updated = JSON.parse(result.stdout).hookSpecificOutput?.updatedInput;
      if (updated && typeof updated === 'object') input = updated;
    } catch {
      continue;
    }
  }
  const answer = await found.server.call(toolName, input, {
    'claudecode/toolUseId': toolUseId,
    progressToken: 1,
  });
  return input === args ? answer : { ...answer, sent: input };
}

/** The command hooks of the PreToolUse event, each with the matcher of its group */
function toolHooks(record) {
  return settingsOf(record).flatMap((settings) => {
    const groups = settings.hooks?.PreToolUse;
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : [])
        .filter((hook) => hook?.type === 'command' && typeof hook.command === 'string')
        .map((hook) => ({
          matcher: typeof group.matcher === 'string' ? group.matcher : '.*',
          hook,
        }))
    );
  });
}

/**
 * `mcp add`, `get` and `remove`. Local scope is kept under the folder of the command in the
 * configuration file, user scope at its top, project scope in the `.mcp.json` of the folder.
 */
async function mcp(argv) {
  const [action, ...rest] = argv;
  const { values, positionals } = parseArgs(rest, MCP_FLAGS);
  const [name, command, ...args] = positionals;
  const cwd = process.cwd();
  if (name === undefined || (values.scope !== undefined && !MCP_SCOPES.includes(values.scope))) {
    throw new Unsupported();
  }
  const places = {
    local: {
      file: configFile(),
      read: (config) => config.projects?.[cwd]?.mcpServers,
      write: (config, servers) => ({
        ...config,
        projects: { ...config.projects, [cwd]: { ...config.projects?.[cwd], mcpServers: servers } },
      }),
    },
    project: {
      file: join(cwd, '.mcp.json'),
      read: (config) => config.mcpServers,
      write: (config, servers) => ({ ...config, mcpServers: servers }),
    },
    user: {
      file: configFile(),
      read: (config) => config.mcpServers,
      write: (config, servers) => ({ ...config, mcpServers: servers }),
    },
  };
  const serversIn = (scope) => places[scope].read(readJson(places[scope].file, {})) ?? {};
  const save = (scope, servers) => {
    const { file, write } = places[scope];
    writeJson(file, write(readJson(file, {}), servers));
  };

  if (action === 'add') {
    const scope = values.scope ?? 'local';
    const env = envPairs(values.env ?? []);
    if (command === undefined || env === undefined) throw new Unsupported();
    const servers = serversIn(scope);
    if (Object.hasOwn(servers, name)) {
      throw new CliError(`MCP server ${name} already exists in ${scope} config`);
    }
    save(scope, { ...servers, [name]: { type: 'stdio', command, args, env } });
    return print(
      `Added stdio MCP server ${name} with command: ${[command, ...args].join(' ')} to ${scope} config`
    );
  }
  if (positionals.length !== 1) throw new Unsupported();
  const scopes = values.scope ? [values.scope] : MCP_SCOPES;
  const scope = scopes.find((candidate) => Object.hasOwn(serversIn(candidate), name));
  if (action === 'get') {
    if (!scope) throw new CliError(`No MCP server named "${name}".`);
    const server = serversIn(scope)[name];
    return print(
      `${name}:\n  Scope: ${scope}\n  Type: stdio\n  Command: ${server.command}\n  Args: ${(server.args ?? []).join(' ')}`
    );
  }
  if (action !== 'remove') throw new Unsupported();
  if (!scope) {
    throw new CliError(
      values.scope
        ? `No MCP server named "${name}" in ${values.scope} scope`
        : `No MCP server named "${name}"`
    );
  }
  const { [name]: _removed, ...kept } = serversIn(scope);
  save(scope, kept);
  return print(`Removed MCP server ${name} from ${scope} config`);
}

async function nextMessage(spool) {
  for (;;) {
    const message = takeNext(spool);
    if (message !== undefined) return message;
    await sleep(POLL_MS);
  }
}

function setActivity({ record, files }, status) {
  const state = status === 'busy' ? 'working' : 'done';
  patchJson(files.record, record.kind === 'background' ? { status, state } : { status });
}

function endSession(recordFile) {
  abandonWork();
  patchJson(recordFile, {
    pid: undefined,
    status: undefined,
    hookPids: undefined,
    state: 'stopped',
  });
  process.exit(0);
}

/**
 * Runs the Stop hooks of a session that just went idle. The session waits for a plain hook,
 * a hook with `asyncRewake` or `async` is left running, also across later turns.
 */
async function fireStopHooks(session, answer, wokenByHook) {
  const { record, files } = session;
  const payload = JSON.stringify({
    session_id: record.sessionId,
    transcript_path: files.transcript,
    cwd: record.cwd,
    permission_mode: record.permissionMode ?? 'default',
    hook_event_name: 'Stop',
    stop_hook_active: wokenByHook,
    last_assistant_message: answer,
  });
  for (const hook of stopHooks(record)) {
    const ended = runHook(session, hook, payload);
    if (hook.asyncRewake === true) void ended.then((result) => wake(files, rewakeText(result)));
    else if (hook.async !== true) wake(files, blockingText(await ended));
  }
}

/** The command hooks of the Stop event from `--settings` and the two project settings files */
function stopHooks(record) {
  return settingsOf(record).flatMap((settings) => commandHooks(settings));
}

function commandHooks(settings) {
  const groups = settings?.hooks?.Stop;
  if (!Array.isArray(groups)) return [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .filter((hook) => hook?.type === 'command' && typeof hook.command === 'string');
}

function runHook(session, hook, payload) {
  const timeoutS = typeof hook.timeout === 'number' ? hook.timeout : DEFAULT_HOOK_TIMEOUT_S;
  const shell = startShell(hook.command, {
    cwd: session.record.cwd,
    env: session.env,
    input: payload,
    timeoutMs: timeoutS * 1000,
    killSignal: 'SIGTERM',
  });
  if (shell.pid === undefined) return shell.done;
  trackHook(session, (pids) => pids.add(shell.pid));
  return shell.done.finally(() => trackHook(session, (pids) => pids.delete(shell.pid)));
}

/** Keeps the pids of the running hooks in the record, for whoever has to clean up after a crash */
function trackHook(session, change) {
  change(session.hookPids);
  patchJson(session.files.record, { hookPids: [...session.hookPids] });
}

const asksForTurn = ({ code, timedOut }) => code === 2 && !timedOut;

function blockingText(result) {
  return (asksForTurn(result) && result.stderr.trim()) || undefined;
}

function rewakeText(result) {
  return asksForTurn(result) ? result.stderr.trim() || result.stdout.trim() : undefined;
}

function wake(files, text) {
  if (text !== undefined) enqueue(files.spool, { wokenBy: 'hook', text });
}

/** A record as it stands now: a session whose process is gone counts as stopped */
function current(record) {
  if (record.pid !== undefined && isAlive(record.pid)) return record;
  return { ...record, pid: undefined, status: undefined, hookPids: undefined, state: 'stopped' };
}

function listSessions() {
  return listRecords(sessionsDir())
    .map(current)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Finds a session by its session id or short id, or else the newest one with that name */
function findSession(argv) {
  const [ref] = argv;
  if (argv.length !== 1) throw new Unsupported();
  const newestFirst = listSessions().reverse();
  const found =
    newestFirst.find(({ sessionId }) => sessionId === ref || shortId(sessionId) === ref) ??
    newestFirst.find(({ name }) => name === ref);
  if (found === undefined) throw new CliError(`No session found for '${ref}'`);
  return found;
}

async function agents(argv) {
  const { values, positionals } = parseArgs(argv, AGENTS_FLAGS);
  if (values.help) return print(renderHelp(AGENTS_HELP, missing()));
  if (values.json && missing().has('agents-json'))
    throw new CliError("error: unknown option '--json'");
  if (!values.json || positionals.length > 0) throw new Unsupported();
  const sessions = listSessions()
    .filter(({ pid }) => values.all || pid !== undefined)
    .filter(({ cwd }) => values.cwd === undefined || isWithin(cwd, values.cwd));
  await print(JSON.stringify(sessions.map(listed), null, 2));
}

/** What `agents --json` shows of a session: `id` and `state` are there for background ones only */
function listed({ id, sessionId, name, cwd, kind, startedAt, pid, status, state }) {
  const shown = { id, sessionId, name, cwd, kind, startedAt, pid, status };
  return kind === 'background' ? { ...shown, state } : shown;
}

async function stopSession({ pid }) {
  if (pid !== undefined) await terminate(pid);
}

async function stop(argv) {
  await stopSession(findSession(argv));
}

async function remove(argv) {
  const session = findSession(argv);
  await stopSession(session);
  const files = sessionFiles(session.sessionId);
  rmSync(files.record, { force: true });
  rmSync(files.transcript, { force: true });
  rmSync(files.spool, { recursive: true, force: true });
}

async function say(argv) {
  const [ref, text] = argv;
  if (argv.length !== 2) throw new Unsupported();
  const session = findSession([ref]);
  if (session.pid === undefined) throw new CliError(`Session '${ref}' is not running`);
  enqueue(sessionFiles(session.sessionId).spool, { wokenBy: 'user', text });
}

await runCli('claude', main);
