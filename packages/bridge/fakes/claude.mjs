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
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  several,
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
const DEFAULT_NOTICE_MS = 100;
const NOT_TRUSTED =
  'Workspace not trusted. Run claude once in this folder and accept the trust prompt';

const OPEN_FLAGS = {
  '--settings': option('settings'),
  '--mcp-config': several('mcpConfig'),
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
  '  --mcp-config <configs...>      Load MCP servers from JSON files or strings',
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
  return {
    record: `${base}.json`,
    transcript: `${base}.jsonl`,
    spool: `${base}.in`,
    answer: `${base}.answer`,
  };
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
    case '__answer':
      return answerPrompt(rest);
    case '__session':
      return runSession(rest);
    default:
      return background(argv);
  }
}

async function background(argv) {
  const { values, positionals } = parseArgs(argv, START_FLAGS);
  const [prompt] = positionals;
  const brokenServers = mcpConfigProblem(values.mcpConfig);
  const promptIsThere = positionals.length === 1 && prompt.trim() !== '';
  const promptWasTaken = positionals.length === 0 && brokenServers !== undefined;
  if (!values.bg || !(promptIsThere || promptWasTaken)) throw new Unsupported();
  for (const [feature, name] of REMOVABLE_START_OPTIONS) {
    if (missing().has(feature) && values[feature] !== undefined) {
      throw new CliError(`error: unknown option '${name}'`);
    }
  }
  if (process.env.FAKE_CLAUDE_BG_FAIL) throw new CliError(process.env.FAKE_CLAUDE_BG_FAIL);
  if (!isTrusted(process.cwd())) throw new CliError(NOT_TRUSTED);
  if (brokenServers !== undefined) {
    const failed = failedSession(values.name, brokenServers);
    return print(`backgrounded · ${failed.id} (idle — send a prompt to start)`);
  }
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
  const brokenServers = mcpConfigProblem(mcpConfig);
  if (brokenServers !== undefined) throw new CliError(`Error: ${brokenServers}`);
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

/**
 * The record of a background session that died before it began: `claude --bg` still says it
 * started one and exits with 0, and `agents --json --all` shows the session as `failed`.
 */
function failedSession(name, detail) {
  const sessionId = randomUUID();
  const record = {
    id: shortId(sessionId),
    sessionId,
    name,
    cwd: process.cwd(),
    kind: 'background',
    startedAt: Date.now(),
    state: 'failed',
    detail: `exit 1 before init — Error: ${detail}`,
  };
  writeJson(sessionFiles(sessionId).record, record);
  return record;
}

/**
 * What is wrong with the values of `--mcp-config`, if anything. The option takes every argument
 * up to the next option, so a prompt right after it is read as one more file of servers.
 */
function mcpConfigProblem(values = []) {
  for (const value of values) {
    const file = resolve(process.cwd(), value);
    if (!value.trimStart().startsWith('{') && !existsSync(file)) {
      return `Invalid MCP configuration: MCP config file not found: ${file}`;
    }
    try {
      readSettingsOption(value, process.cwd());
    } catch (error) {
      return `Invalid MCP configuration: ${error.message}`;
    }
  }
  return undefined;
}

const shortId = (sessionId) => sessionId.slice(0, 8);

/** The value of `--settings`: a JSON string, or the path of a JSON file */
function readSettingsOption(value, cwd) {
  const json = value.trimStart().startsWith('{')
    ? value
    : readFileSync(resolve(cwd, value), 'utf8');
  return JSON.parse(json);
}

function checkSettings(value) {
  if (value === undefined) return;
  try {
    readSettingsOption(value, process.cwd());
  } catch (error) {
    throw new CliError(`Error: cannot load --settings: ${error.message}`);
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
      askLeave: ({ tool, input }) => leaveFor(session, tool, input),
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
  for (const value of record.mcpConfig ?? []) {
    Object.assign(servers, readSettingsOption(value, record.cwd).mcpServers);
  }
  return servers;
}

/** The settings a session goes by: `--settings` and the two settings files of its project */
function settingsOf(record) {
  const project = join(record.projectDir ?? record.cwd, '.claude');
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

/**
 * Whether a permission rule covers a call: the name of the tool alone, or the tool with a
 * pattern for its command or file. `Bash(git push *)` and `Bash(git push:*)` cover what starts
 * with the words, `Bash(git status)` that command only.
 */
function ruleCovers(rule, toolName, input) {
  if (rule === toolName) return true;
  const match = /^([\w-]+)\((.*)\)$/.exec(rule);
  if (!match || match[1] !== toolName) return false;
  const [, , pattern] = match;
  const subject = String(input.command ?? input.file_path ?? '');
  if (pattern.endsWith(':*')) return subject.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith(' *')) {
    return subject === pattern.slice(0, -2) || subject.startsWith(pattern.slice(0, -1));
  }
  return subject === pattern;
}

/**
 * Gets leave for a call of one of the session's own tools, the way Claude Code decides: the
 * mode (`acceptEdits` takes an edit inside the folder of the session), the deny and allow rules,
 * the `PermissionRequest` hooks that match the tool, and when none of them settles it, the
 * dialog a person answers with `__answer`, however long that takes. From the moment the call
 * needs leave the session is listed as blocked on a permission prompt, also while a hook still
 * decides, and when nothing has decided after `FAKE_CLAUDE_NOTIFY_MS` its `Notification` hooks
 * are told (Claude Code takes about six seconds).
 */
async function leaveFor(session, toolName, input) {
  const moved = toolName === 'Edit' ? isolate(session, input.file_path) : undefined;
  const leave = await decideLeave(
    session,
    toolName,
    moved ? { ...input, file_path: moved.file } : input
  );
  return moved ? { ...leave, ...moved } : leave;
}

function gitSays(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Moves a background session into a git worktree of its own before its first edit. Claude Code
 * refuses the edit and has the model enter a worktree, which comes to the same for a model that
 * does as it is told: `.claude/worktrees/<name>` under the top of the repository, on a branch
 * `worktree-<name>`. Not when its settings say `worktree.bgIsolation: "none"`, not outside a git
 * repository, and not when it is in a linked worktree already. The settings of the project it
 * was started in stay the ones it reads.
 * @returns {{ cwd: string, file: string } | undefined} where the session is now and which file
 * the edit means there, undefined for a session that stays where it is
 */
function isolate(session, file) {
  const { record, files } = session;
  if (record.kind !== 'background') return undefined;
  if (settingsOf(record).some((settings) => settings.worktree?.bgIsolation === 'none')) {
    return undefined;
  }
  const top = gitSays(record.cwd, ['rev-parse', '--show-toplevel']);
  const isMain = top !== undefined && statSync(join(top, '.git')).isDirectory();
  if (!isMain) return undefined;
  const name = `session-${record.id}`;
  const path = join(top, '.claude', 'worktrees', name);
  if (gitSays(top, ['worktree', 'add', '-b', `worktree-${name}`, path, 'HEAD']) === undefined) {
    throw new Error(`fake claude could not make the worktree ${path}`);
  }
  const into = (place) =>
    isWithin(place, top) ? join(path, relative(canonical(top), canonical(place))) : place;
  const started = record.cwd;
  record.projectDir = started;
  record.cwd = into(started);
  patchJson(files.record, { cwd: record.cwd, projectDir: started });
  return { cwd: record.cwd, file: into(file) };
}

async function decideLeave(session, toolName, input) {
  const { record, files } = session;
  const mode = record.permissionMode ?? 'default';
  const refused = (message) => ({ allowed: false, message });
  const rules = (list) =>
    settingsOf(record).flatMap((settings) => settings.permissions?.[list] ?? []);
  const covered = (list) => rules(list).some((rule) => ruleCovers(rule, toolName, input));
  if (covered('deny')) return refused(`Permission to use ${toolName} has been denied.`);
  if (mode === 'bypassPermissions' || covered('allow')) return { allowed: true };
  const edited = toolName === 'Edit' && typeof input.file_path === 'string' && input.file_path;
  if (mode === 'acceptEdits' && edited && isWithin(edited, record.cwd)) {
    return { allowed: true };
  }

  const payload = {
    session_id: record.sessionId,
    transcript_path: files.transcript,
    cwd: record.cwd,
    permission_mode: mode,
    tool_name: toolName,
    tool_input: input,
  };
  rmSync(files.answer, { force: true });
  patchJson(files.record, {
    status: 'waiting',
    waitingFor: 'permission prompt',
    ...(record.kind === 'background' && { state: 'blocked' }),
  });
  const notice = setTimeout(() => tellOfPrompt(session), noticeDelayMs());
  const settled = (leave) => {
    clearTimeout(notice);
    patchJson(files.record, {
      status: 'busy',
      waitingFor: undefined,
      dialog: undefined,
      ...(record.kind === 'background' && { state: 'working' }),
    });
    return leave;
  };

  let allowedByHook = false;
  for (const { matcher, hook } of eventHooks(record, 'PermissionRequest')) {
    if (!new RegExp(`^(?:${matcher})$`).test(toolName)) continue;
    const result = await runHook(
      session,
      hook,
      JSON.stringify({ ...payload, hook_event_name: 'PermissionRequest' })
    );
    if (result.code !== 0) continue;
    let decision;
    try {
      decision = JSON.parse(result.stdout).hookSpecificOutput?.decision;
    } catch {
      continue;
    }
    if (decision?.behavior === 'deny') {
      return settled(
        refused(String(decision.message ?? `Permission to use ${toolName} has been denied.`))
      );
    }
    if (decision?.behavior === 'allow') allowedByHook = true;
  }
  if (allowedByHook) return settled({ allowed: true });
  if (mode === 'dontAsk') {
    return settled(refused(`Permission to use ${toolName} has been denied.`));
  }

  patchJson(files.record, { dialog: true });
  let answer;
  while ((answer = readJson(files.answer)) === undefined) await sleep(POLL_MS);
  rmSync(files.answer, { force: true });
  return settled(
    answer.allow === true
      ? { allowed: true }
      : refused(`The user doesn't want to proceed with this tool use.`)
  );
}

function noticeDelayMs() {
  const value = Number(process.env.FAKE_CLAUDE_NOTIFY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_NOTICE_MS;
}

/** Tells the `Notification` hooks for permission prompts that the session waits for leave */
function tellOfPrompt(session) {
  const { record, files } = session;
  for (const { matcher, hook } of eventHooks(record, 'Notification')) {
    if (matcher !== '.*' && !new RegExp(`^(?:${matcher})$`).test('permission_prompt')) continue;
    void runHook(
      session,
      hook,
      JSON.stringify({
        session_id: record.sessionId,
        transcript_path: files.transcript,
        cwd: record.cwd,
        hook_event_name: 'Notification',
        message: 'Claude needs your permission',
        title: 'Permission needed',
        notification_type: 'permission_prompt',
      })
    );
  }
}

/** The command hooks of an event, each with the matcher of its group */
function eventHooks(record, event) {
  return settingsOf(record).flatMap((settings) => {
    const groups = settings.hooks?.[event];
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : [])
        .filter((hook) => hook?.type === 'command' && typeof hook.command === 'string')
        .map((hook) => ({
          matcher: typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : '.*',
          hook,
        }))
    );
  });
}

/** The command hooks of the PreToolUse event, each with the matcher of its group */
function toolHooks(record) {
  return eventHooks(record, 'PreToolUse');
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
    waitingFor: undefined,
    dialog: undefined,
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

/** A record as it stands now: a session whose process is gone counts as stopped, unless it never began */
function current(record) {
  if (record.state === 'failed') return record;
  if (record.pid !== undefined && isAlive(record.pid)) return record;
  return {
    ...record,
    pid: undefined,
    status: undefined,
    waitingFor: undefined,
    dialog: undefined,
    hookPids: undefined,
    state: 'stopped',
  };
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
function listed({ id, sessionId, name, cwd, kind, startedAt, pid, status, state, waitingFor }) {
  const shown = { id, sessionId, name, cwd, kind, startedAt, pid, status, waitingFor };
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
  rmSync(files.answer, { force: true });
}

/** `__answer <session> allow|deny`: a person answers the permission dialog a session shows */
async function answerPrompt(argv) {
  const [ref, word] = argv;
  if (argv.length !== 2 || (word !== 'allow' && word !== 'deny')) throw new Unsupported();
  const session = findSession([ref]);
  if (session.dialog !== true) {
    throw new CliError(`Session '${ref}' shows no permission dialog`);
  }
  writeJson(sessionFiles(session.sessionId).answer, { allow: word === 'allow' });
}

async function say(argv) {
  const [ref, text] = argv;
  if (argv.length !== 2) throw new Unsupported();
  const session = findSession([ref]);
  if (session.pid === undefined) throw new CliError(`Session '${ref}' is not running`);
  enqueue(sessionFiles(session.sessionId).spool, { wokenBy: 'user', text });
}

await runCli('claude', main);
