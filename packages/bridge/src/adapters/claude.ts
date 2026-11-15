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
import { findProjectRoot } from '../paths.js';
import { HARNESSES, type CallerIdentity } from '../types.js';
import {
  CommandMissingError,
  failureOf,
  fitsArgument,
  pause,
  runCommand,
  sessionEnv,
  tooLongNotice,
} from './exec.js';

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

function quoteArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command a hook of a Claude Code session runs to wait for the session's mail. */
export function claudeWaitCommand(options: ClaudeWaitHookOptions = {}): string {
  const timeoutS = options.timeoutS ?? DEFAULT_HOOK_TIMEOUT_S;
  const waitS = Math.max(1, timeoutS - HOOK_MARGIN_S);
  return [
    options.bridgeCommand ?? 'cogitator bridge',
    'wait',
    `--hook ${HARNESSES.claudeCode}`,
    `--timeout ${waitS}`,
    ...(options.agentName ? [`--agent ${quoteArgument(options.agentName)}`] : []),
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
              timeout: options.timeoutS ?? DEFAULT_HOOK_TIMEOUT_S,
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

const SettingsSchema = z.object({
  hooks: z
    .object({
      Stop: z
        .array(
          z.object({
            hooks: z
              .array(
                z.object({ command: z.string().optional(), asyncRewake: z.boolean().optional() })
              )
              .optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

const HookInputSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

const ListedSessionSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
});

const TrustConfigSchema = z.object({
  projects: z
    .record(z.string(), z.object({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

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
}

const DEFAULT_SESSION_LISTED_MS = 30_000;
const LISTING_INTERVAL_MS = 300;
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
  const hook = {
    ...(options.bridgeCommand !== undefined && { bridgeCommand: options.bridgeCommand }),
    ...(options.hookTimeoutS !== undefined && { timeoutS: options.hookTimeoutS }),
  };

  async function listed(): Promise<z.output<typeof ListedSessionSchema>[]> {
    const result = await runCommand(command, ['agents', '--json'], { env });
    if (result.code !== 0) throw new Error(`claude agents --json failed: ${failureOf(result)}`);
    const parsed = z.array(ListedSessionSchema).safeParse(JSON.parse(result.stdout || '[]'));
    if (!parsed.success)
      throw new Error('claude agents --json printed something the bridge cannot read');
    return parsed.data;
  }

  async function sessionOf(shortId: string): Promise<{ sessionId: string; name?: string }> {
    const deadline = Date.now() + (options.sessionListedMs ?? DEFAULT_SESSION_LISTED_MS);
    for (;;) {
      const session = (await listed()).find((candidate) => candidate.id === shortId);
      if (session?.sessionId) {
        return { sessionId: session.sessionId, ...(session.name && { name: session.name }) };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude Code started the background session ${shortId}, but it never showed up in claude agents --json`
        );
      }
      await pause(LISTING_INTERVAL_MS);
    }
  }

  async function createSession(request: SessionRequest): Promise<CreatedSession> {
    if (claudeTrust(request.cwd, configPath) === 'untrusted') throw untrusted(request.cwd);
    const whole = fitsArgument(request.firstLetter.text);
    const settings = claudeWaitHook({ ...hook, agentName: request.agentName });
    const result = await runCommand(
      command,
      [
        '--bg',
        '--settings',
        JSON.stringify(settings),
        ...(request.sessionName ? ['--name', request.sessionName] : []),
        ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
        ...(options.sessionArgs ?? []),
        whole ? request.firstLetter.text : tooLongNotice(request.firstLetter),
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
    const session = await sessionOf(shortId);
    return {
      sessionId: session.sessionId,
      ...(session.name && { sessionName: session.name }),
      deliveredFirstLetter: whole,
    };
  }

  async function liveSessions(): Promise<LiveSession[]> {
    let sessions: z.output<typeof ListedSessionSchema>[];
    try {
      sessions = await listed();
    } catch (error) {
      if (error instanceof CommandMissingError) return [];
      throw error;
    }
    return sessions.flatMap((session) =>
      session.sessionId
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
      ...(!armed && {
        fix: `Merge into ${places[0]}: ${JSON.stringify(claudeWaitHook(hook))}`,
      }),
    });
    return checks;
  }

  return {
    harness: HARNESSES.claudeCode,
    delivery: CLAUDE_DELIVERY,
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
    createSession,
    liveSessions,
    identify,
    health,
  };
}
