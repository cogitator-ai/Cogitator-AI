import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  BridgeAdapter,
  CreatedSession,
  HealthCheck,
  HealthContext,
  IdentifyContext,
  LiveSession,
  SessionRequest,
} from '../adapter.js';
import { canonicalPath, findProjectRoot } from '../paths.js';
import { TOOL_CALL_HINT_KEY, type ToolCallHint } from '../tools/caller.js';
import { HARNESSES, type CallerIdentity } from '../types.js';
import {
  CommandMissingError,
  failureOf,
  fitsArgument,
  pause,
  runCommand,
  sessionEnv,
  shellQuote,
  tooLongNotice,
} from './exec.js';
import { BRIDGE_TOOLS_SERVER, toolsServerEnv, type ToolsServerCommand } from './tools-server.js';

/** How letters reach a Claude Code session: a hook of the session waits for them. */
export const CLAUDE_DELIVERY = 'hook';

/** How long a waiter of a Claude Code session waits before Claude Code ends it, 12 hours. */
export const DEFAULT_HOOK_TIMEOUT_S = 12 * 3600;

/** The waiter leaves this long before its hook's timeout, so it ends by itself and not mid-answer. */
const HOOK_MARGIN_S = 60;

export interface ClaudeWaitHookOptions {
  /** How the bridge's command line is run, `cogitator bridge` by default */
  bridgeCommand?: string;
  /** Seconds the hook may run, 12 hours by default */
  timeoutS?: number;
  /** The name the bridge gave the session, for one it started itself */
  agentName?: string;
  /** The folder of the bridge's files, when it is not the default one */
  bridgeHome?: string;
  /** Whether the session has the bridge's tools: the waiter then says to answer with them */
  tools?: boolean;
}

export interface ClaudeHookSettings {
  hooks: {
    Stop: {
      hooks: {
        type: 'command';
        command: string;
        timeout: number;
        async: true;
        asyncRewake: true;
      }[];
    }[];
  };
}

/** The command a hook of a Claude Code session runs to wait for the session's mail. */
export function claudeWaitCommand(options: ClaudeWaitHookOptions = {}): string {
  const timeoutS = options.timeoutS ?? DEFAULT_HOOK_TIMEOUT_S;
  const waitS = Math.max(1, Math.floor(timeoutS - HOOK_MARGIN_S));
  return [
    options.bridgeCommand ?? 'cogitator bridge',
    'wait',
    `--hook ${HARNESSES.claudeCode}`,
    `--timeout ${waitS}`,
    ...(options.agentName ? [`--agent ${shellQuote(options.agentName)}`] : []),
    ...(options.bridgeHome ? [`--home ${shellQuote(options.bridgeHome)}`] : []),
    ...(options.tools ? ['--tools'] : []),
  ].join(' ');
}

/**
 * The settings that make a Claude Code session wake for its mail: a `Stop` hook that runs in the
 * background after every turn (`async`), waits at the bridge, and wakes the session with what it
 * got (`asyncRewake`: the hook exits with code 2 and its stderr becomes the session's next
 * input). The session is free while the hook waits. Merge them into the project's
 * `.claude/settings.local.json`, or pass them to one session with `claude --settings`.
 */
export function claudeWaitHook(options: ClaudeWaitHookOptions = {}): ClaudeHookSettings {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: claudeWaitCommand(options),
              timeout: Math.ceil(options.timeoutS ?? DEFAULT_HOOK_TIMEOUT_S),
              async: true,
              asyncRewake: true,
            },
          ],
        },
      ],
    },
  };
}

/** Whether Claude Code settings hold a hook that waits at the bridge. */
export function hasClaudeWaitHook(settings: unknown): boolean {
  const parsed = SettingsSchema.safeParse(settings);
  if (!parsed.success) return false;
  return (parsed.data.hooks?.Stop ?? []).some((group) =>
    (group.hooks ?? []).some(
      (hook) => hook.asyncRewake === true && /\bbridge\s+wait\b/.test(hook.command ?? '')
    )
  );
}

const HookGroupsSchema = z
  .array(
    z.object({
      hooks: z
        .array(z.object({ command: z.string().optional(), asyncRewake: z.boolean().optional() }))
        .optional(),
    })
  )
  .optional();

const SettingsSchema = z.object({
  hooks: z.object({ Stop: HookGroupsSchema, PreToolUse: HookGroupsSchema }).optional(),
});

/** How a Claude Code session names the tools of the bridge's server, and what rules match them by. */
export const CLAUDE_TOOLS_PREFIX = `mcp__${BRIDGE_TOOLS_SERVER}`;

/** The permission rule that lets a session call the bridge's tools without a prompt. */
export const CLAUDE_TOOLS_PERMISSION = CLAUDE_TOOLS_PREFIX;

/** Seconds the hook that names the session of a tool call may take. */
const CALLER_HOOK_TIMEOUT_S = 15;

export interface ClaudeToolsHookOptions {
  /** How the bridge's command line is run, `cogitator bridge` by default */
  bridgeCommand?: string;
}

export interface ClaudeToolsHookSettings {
  hooks: {
    PreToolUse: {
      matcher: string;
      hooks: { type: 'command'; command: string; timeout: number }[];
    }[];
  };
}

/** The command a hook of a Claude Code session runs before a call of a bridge tool. */
export function claudeCallerCommand(options: ClaudeToolsHookOptions = {}): string {
  return `${options.bridgeCommand ?? 'cogitator bridge'} caller --hook ${HARNESSES.claudeCode}`;
}

/**
 * The settings that tell the bridge's tools which Claude Code session calls them: a `PreToolUse`
 * hook on the tools of the bridge's server that adds the session to the arguments of the call.
 * Claude Code starts the server once and keeps it across `/clear`, so the session the server was
 * started for is not always the one that calls. Without the hook the tools go by that first
 * session.
 */
export function claudeToolsHook(options: ClaudeToolsHookOptions = {}): ClaudeToolsHookSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: `${CLAUDE_TOOLS_PREFIX}__.*`,
          hooks: [
            {
              type: 'command',
              command: claudeCallerCommand(options),
              timeout: CALLER_HOOK_TIMEOUT_S,
            },
          ],
        },
      ],
    },
  };
}

/** Whether Claude Code settings hold the hook that names the session of a bridge tool call. */
export function hasClaudeToolsHook(settings: unknown): boolean {
  const parsed = SettingsSchema.safeParse(settings);
  if (!parsed.success) return false;
  return (parsed.data.hooks?.PreToolUse ?? []).some((group) =>
    (group.hooks ?? []).some((hook) => /\bbridge\s+caller\b/.test(hook.command ?? ''))
  );
}

const ToolHookInputSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
  tool_input: z.record(z.string(), z.unknown()),
});

/**
 * What the hook of `claudeToolsHook` answers Claude Code with: the arguments of the call with
 * the session that makes it added (`hookSpecificOutput.updatedInput`). Undefined when the input
 * is not that of a `PreToolUse` hook, and the call goes on as the model wrote it.
 *
 * @param hookInput what Claude Code wrote to the hook's stdin
 */
export function claudeToolCallHook(hookInput: string): string | undefined {
  let input: unknown;
  try {
    input = JSON.parse(hookInput);
  } catch {
    return undefined;
  }
  const parsed = ToolHookInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { session_id: session, cwd, tool_input: args } = parsed.data;
  const hint: ToolCallHint = {
    harness: HARNESSES.claudeCode,
    session,
    ...(cwd && { cwd: resolve(cwd) }),
  };
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...args, [TOOL_CALL_HINT_KEY]: hint },
    },
  });
}

const HookInputSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

const ListedSessionSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  pid: z.number().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
});

const ServersSchema = z.record(z.string(), z.unknown()).optional();

const TrustConfigSchema = z.object({
  projects: z
    .record(
      z.string(),
      z.object({ hasTrustDialogAccepted: z.boolean().optional(), mcpServers: ServersSchema })
    )
    .optional(),
  mcpServers: ServersSchema,
});

const ProjectServersSchema = z.object({ mcpServers: ServersSchema });

/**
 * Where Claude Code has the bridge's server of tools for the sessions of a folder: `local`
 * (this person, this project), `project` (the project's `.mcp.json`) or `user` (this person,
 * every project). Undefined when it has it nowhere.
 */
export function claudeToolsScope(
  folder: string,
  configPath = join(homedir(), '.claude.json')
): 'local' | 'project' | 'user' | undefined {
  const config = TrustConfigSchema.safeParse(readJson(configPath));
  const projects = config.success ? (config.data.projects ?? {}) : {};
  const folders = spellingsOf(folder).flatMap((start) => {
    const up: string[] = [];
    for (let current = start; ; current = dirname(current)) {
      up.push(current);
      if (dirname(current) === current) return up;
    }
  });
  if (folders.some((dir) => projects[dir]?.mcpServers?.[BRIDGE_TOOLS_SERVER] !== undefined)) {
    return 'local';
  }
  const shared = folders.some((dir) => {
    const file = ProjectServersSchema.safeParse(readJson(join(dir, '.mcp.json')));
    return file.success && file.data.mcpServers?.[BRIDGE_TOOLS_SERVER] !== undefined;
  });
  if (shared) return 'project';
  return config.success && config.data.mcpServers?.[BRIDGE_TOOLS_SERVER] !== undefined
    ? 'user'
    : undefined;
}

/**
 * The ways a folder may be written in what Claude Code keeps: by its real path, which is how
 * Claude Code names a project, and as it was given.
 */
function spellingsOf(folder: string): string[] {
  return [...new Set([canonicalPath(folder), resolve(folder)])];
}

export type ClaudeTrust = 'trusted' | 'untrusted' | 'unknown';

/**
 * Whether Claude Code trusts a folder, read from where it records that a person accepted its
 * trust prompt (`projects[<folder>].hasTrustDialogAccepted` in `~/.claude.json`). Trust of a
 * folder covers the folders inside it. `unknown` when the record cannot be read.
 */
export function claudeTrust(
  folder: string,
  configPath = join(homedir(), '.claude.json')
): ClaudeTrust {
  let config: z.output<typeof TrustConfigSchema>;
  try {
    const parsed = TrustConfigSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
    if (!parsed.success) return 'unknown';
    config = parsed.data;
  } catch {
    return 'unknown';
  }
  const projects = config.projects ?? {};
  for (let current = resolve(folder); ; current = dirname(current)) {
    if (projects[current]?.hasTrustDialogAccepted) return 'trusted';
    if (dirname(current) === current) return 'untrusted';
  }
}

export interface ClaudeCodeAdapterOptions {
  /** The Claude Code executable, `claude` on `PATH` by default */
  command?: string;
  /** How a session's hook runs the bridge's command line, `cogitator bridge` by default */
  bridgeCommand?: string;
  /**
   * The folder of the bridge's files the sessions call, when it is not the default one:
   * `COGITATOR_BRIDGE_HOME` of `env` when that is set. A hook is told it on its command line,
   * since Claude Code does not promise a background session the environment it was started in
   */
  bridgeHome?: string;
  /** The environment of the commands and of the sessions it starts, `process.env` by default */
  env?: NodeJS.ProcessEnv;
  /** The permission mode of the sessions it starts, Claude Code's own default when absent */
  permissionMode?: string;
  /** More arguments for `claude --bg`, such as `['--model', 'sonnet']` */
  sessionArgs?: readonly string[];
  /** Seconds a waiter may wait before Claude Code ends it, 12 hours by default */
  hookTimeoutS?: number;
  /**
   * Where Claude Code records the folders it trusts: `.claude.json` in `CLAUDE_CONFIG_DIR` when
   * the environment sets it, `~/.claude.json` otherwise
   */
  configPath?: string;
  /**
   * Where Claude Code keeps a person's settings: `settings.json` in `CLAUDE_CONFIG_DIR` when the
   * environment sets it, `~/.claude/settings.json` otherwise
   */
  userSettingsPath?: string;
  /** How long a started session may take to show up among the running ones, 30 s by default */
  sessionListedMs?: number;
  /**
   * How a session starts the bridge's server of tools. With it the sessions the adapter starts
   * get the tools, the hook that tells the tools which session calls, and the permission to call
   * them. Without it they use the bridge's command line
   */
  toolsServer?: ToolsServerCommand;
}

/** What sets a project up for the sessions a person opens in it. */
const INSTALL = 'cogitator bridge install claude';

const DEFAULT_SESSION_LISTED_MS = 30_000;
const LISTING_INTERVAL_MS = 300;
/** How `claude agents --json` marks a background session that died before it began */
const FAILED_STATE = 'failed';
const SHORT_ID = /backgrounded\s*[·:-]?\s*([0-9a-f]{6,})\b/i;

function untrusted(folder: string): Error {
  return new Error(
    `Claude Code does not trust ${folder} yet. Open the folder in Claude Code once and accept its trust prompt, then hand the job over again`
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Reaches Claude Code sessions in their own windows. A session started for a job runs in the
 * background of Claude Code (`claude --bg`): `claude attach` opens it, `claude agents` lists it.
 * Letters reach a session through a hook of its own: after every turn the hook waits at the
 * bridge (`cogitator bridge wait`) and wakes the session with the mail, so nothing is pushed
 * into a window from outside and the session stays free to talk to. A session the bridge starts
 * carries the hook itself. One opened by a person needs it in the project's settings, see
 * `claudeWaitHook`.
 */
export function claudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): BridgeAdapter {
  const command = options.command ?? 'claude';
  const env = options.env ?? process.env;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const configPath = options.configPath ?? join(configDir || homedir(), '.claude.json');
  const userSettingsPath =
    options.userSettingsPath ?? join(configDir || join(homedir(), '.claude'), 'settings.json');
  const bridgeHome = options.bridgeHome ?? (env.COGITATOR_BRIDGE_HOME?.trim() || undefined);
  const hook = {
    ...(bridgeHome !== undefined && { bridgeHome }),
    ...(options.bridgeCommand !== undefined && { bridgeCommand: options.bridgeCommand }),
    ...(options.hookTimeoutS !== undefined && { timeoutS: options.hookTimeoutS }),
  };

  async function listed(): Promise<z.output<typeof ListedSessionSchema>[]> {
    const result = await runCommand(command, ['agents', '--json', '--all'], { env });
    if (result.code !== 0) throw new Error(`claude agents --json failed: ${failureOf(result)}`);
    const parsed = z.array(ListedSessionSchema).safeParse(JSON.parse(result.stdout || '[]'));
    if (!parsed.success)
      throw new Error('claude agents --json printed something the bridge cannot read');
    return parsed.data;
  }

  async function sessionOf(shortId: string): Promise<{ sessionId: string }> {
    const deadline = Date.now() + (options.sessionListedMs ?? DEFAULT_SESSION_LISTED_MS);
    for (;;) {
      const session = (await listed()).find((candidate) => candidate.id === shortId);
      if (session?.state === FAILED_STATE) {
        throw new Error(
          `Claude Code started the background session ${shortId}, and it failed before its first turn`
        );
      }
      if (session?.sessionId) {
        return { sessionId: session.sessionId };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude Code started the background session ${shortId}, but it never showed up in claude agents --json`
        );
      }
      await pause(LISTING_INTERVAL_MS);
    }
  }

  /**
   * `--mcp-config` takes every argument up to the next option, so it stands before `--settings`
   * and never right before the first letter, which it would read as one more file of servers.
   */
  async function createSession(request: SessionRequest): Promise<CreatedSession> {
    if (claudeTrust(request.cwd, configPath) === 'untrusted') throw untrusted(request.cwd);
    const whole = fitsArgument(request.firstLetter.text);
    const tools = options.toolsServer;
    const waits = claudeWaitHook({ ...hook, agentName: request.agentName, tools: !!tools });
    const settings = tools
      ? {
          hooks: { ...waits.hooks, ...claudeToolsHook(hook).hooks },
          permissions: { allow: [CLAUDE_TOOLS_PERMISSION] },
        }
      : waits;
    const servers = tools && {
      mcpServers: {
        [BRIDGE_TOOLS_SERVER]: {
          command: tools.command,
          args: [...tools.args],
          env: toolsServerEnv({
            harness: HARNESSES.claudeCode,
            agentName: request.agentName,
            ...(request.sessionName && { sessionName: request.sessionName }),
          }),
        },
      },
    };
    const result = await runCommand(
      command,
      [
        '--bg',
        ...(servers ? ['--mcp-config', JSON.stringify(servers)] : []),
        '--settings',
        JSON.stringify(settings),
        ...(request.sessionName ? ['--name', request.sessionName] : []),
        ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
        ...(options.sessionArgs ?? []),
        whole
          ? request.firstLetter.text
          : tooLongNotice(request.firstLetter, {
              ...(options.bridgeCommand !== undefined && { bridgeCommand: options.bridgeCommand }),
              ...(bridgeHome !== undefined && { bridgeHome }),
              tools: !!tools,
            }),
      ],
      {
        cwd: request.cwd,
        env: sessionEnv(env, {
          harness: HARNESSES.claudeCode,
          agentName: request.agentName,
          ...(request.sessionName && { sessionName: request.sessionName }),
        }),
      }
    );
    if (result.code !== 0) {
      if (/not trusted/i.test(result.stderr)) throw untrusted(request.cwd);
      throw new Error(`claude --bg failed: ${failureOf(result)}`);
    }
    const shortId = SHORT_ID.exec(result.stdout)?.[1];
    if (!shortId) {
      throw new Error(
        `claude --bg did not say which session it started: ${failureOf({ ...result, stderr: '' })}`
      );
    }
    let session: { sessionId: string };
    try {
      session = await sessionOf(shortId);
    } catch (error) {
      await runCommand(command, ['stop', shortId], { env }).catch(() => undefined);
      throw error;
    }
    return {
      sessionId: session.sessionId,
      ...(request.sessionName && { sessionName: request.sessionName }),
      deliveredFirstLetter: whole,
    };
  }

  /**
   * The sessions whose process is alive. Background sessions that finished are asked for too
   * (`--all`) and told apart by their process, so a session is never missed for being between
   * two turns
   */
  async function liveSessions(): Promise<LiveSession[]> {
    let sessions: z.output<typeof ListedSessionSchema>[];
    try {
      sessions = await listed();
    } catch (error) {
      if (error instanceof CommandMissingError) return [];
      throw error;
    }
    return sessions.flatMap((session) =>
      session.sessionId && (session.pid !== undefined || session.status !== undefined)
        ? [
            {
              sessionId: session.sessionId,
              ...(session.cwd && { cwd: session.cwd }),
              ...(session.name && { name: session.name }),
              ...(session.status && { busy: session.status === 'busy' }),
            },
          ]
        : []
    );
  }

  function identify(context: IdentifyContext): CallerIdentity | undefined {
    let sessionId = context.env.CLAUDE_CODE_SESSION_ID?.trim();
    let cwd = context.cwd;
    if (context.hookInput !== undefined) {
      let input: unknown;
      try {
        input = JSON.parse(context.hookInput);
      } catch {
        input = undefined;
      }
      const parsed = HookInputSchema.safeParse(input);
      if (parsed.success) {
        sessionId = parsed.data.session_id;
        cwd = parsed.data.cwd ?? cwd;
      }
    }
    if (!sessionId) return undefined;
    const folder = resolve(cwd);
    return {
      harness: HARNESSES.claudeCode,
      sessionId,
      cwd: folder,
      project: findProjectRoot(folder),
    };
  }

  async function health(context: HealthContext): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];
    let help: string;
    try {
      const version = await runCommand(command, ['--version'], { env });
      if (version.code !== 0) throw new Error(failureOf(version));
      checks.push({
        id: 'version',
        title: 'Claude Code',
        status: 'ok',
        detail: version.stdout.trim(),
      });
      help = (await runCommand(command, ['--help'], { env })).stdout;
    } catch (error) {
      checks.push({
        id: 'version',
        title: 'Claude Code',
        status: 'fail',
        detail: error instanceof CommandMissingError ? error.message : String(error),
        fix: 'Install Claude Code: https://claude.com/claude-code',
      });
      return checks;
    }

    const background = /--bg\b/.test(help) && /--settings\b/.test(help);
    checks.push({
      id: 'background',
      title: 'Background sessions',
      status: background ? 'ok' : 'fail',
      detail: background
        ? 'claude --bg and --settings are there'
        : 'this version has no claude --bg or no --settings: the bridge cannot start sessions',
      ...(!background && { fix: 'Update Claude Code: claude update' }),
    });

    const agentsHelp = (await runCommand(command, ['agents', '--help'], { env })).stdout;
    const listing = /--json\b/.test(agentsHelp);
    checks.push({
      id: 'sessions',
      title: 'Session list',
      status: listing ? 'ok' : 'fail',
      detail: listing
        ? 'claude agents --json is there'
        : 'this version has no claude agents --json: the bridge cannot find the sessions it starts',
      ...(!listing && { fix: 'Update Claude Code: claude update' }),
    });

    const trust = claudeTrust(context.cwd, configPath);
    checks.push({
      id: 'trust',
      title: 'Folder trust',
      status: trust === 'trusted' ? 'ok' : 'warn',
      detail:
        trust === 'trusted'
          ? `Claude Code trusts ${context.cwd}`
          : trust === 'untrusted'
            ? `Claude Code does not trust ${context.cwd}: the bridge cannot start sessions in it`
            : `could not read whether Claude Code trusts ${context.cwd}`,
      ...(trust !== 'trusted' && {
        fix: 'Open the folder in Claude Code once and accept its trust prompt',
      }),
    });

    const places = [
      join(context.cwd, '.claude', 'settings.local.json'),
      join(context.cwd, '.claude', 'settings.json'),
      userSettingsPath,
    ];
    const armed = places.find((place) => hasClaudeWaitHook(readJson(place)));
    checks.push({
      id: 'hook',
      title: 'Wake hook',
      status: armed ? 'ok' : 'warn',
      detail: armed
        ? `sessions opened in this folder wait for their mail (${armed})`
        : 'sessions a person opens in this folder do not wake for mail, they read it when asked. Sessions the bridge starts carry the hook themselves',
      ...(!armed && { fix: INSTALL }),
    });

    const scope = claudeToolsScope(context.cwd, configPath);
    checks.push({
      id: 'tools',
      title: 'Bridge tools',
      status: scope ? 'ok' : 'warn',
      detail: scope
        ? `sessions opened in this folder have the bridge's tools (${scope} config)`
        : 'sessions a person opens in this folder have no bridge tools, they use its command line. Sessions the bridge starts get the tools themselves',
      ...(!scope && { fix: INSTALL }),
    });
    if (scope) {
      const named = places.find((place) => hasClaudeToolsHook(readJson(place)));
      checks.push({
        id: 'caller',
        title: 'Session of a tool call',
        status: named ? 'ok' : 'warn',
        detail: named
          ? `a hook tells the tools which session calls them (${named})`
          : 'the tools go by the session their server was started for: after /clear they act as the session before it',
        ...(!named && { fix: INSTALL }),
      });
    }
    return checks;
  }

  function toolCallHook(context: IdentifyContext): string | undefined {
    return context.hookInput === undefined ? undefined : claudeToolCallHook(context.hookInput);
  }

  return {
    harness: HARNESSES.claudeCode,
    delivery: CLAUDE_DELIVERY,
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
    createSession,
    liveSessions,
    identify,
    toolCallHook,
    health,
  };
}
