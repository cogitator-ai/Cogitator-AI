import { resolve } from 'node:path';
import {
  claudeCodeAdapter,
  claudeSetup,
  codexAdapter,
  codexSetup,
  harnessOfAlias,
  shellQuote,
  type AdapterSetup,
  type BridgeAdapter,
  type CodexSandbox,
  type ToolsServerCommand,
} from '@cogitator-ai/bridge';
import { UsageError } from './cli.js';
import { BRIDGE_HOME_ENV } from './daemon.js';

/** Says how sessions run the bridge's command line, when it is not how this process was run. */
export const BRIDGE_COMMAND_ENV = 'COGITATOR_BRIDGE_COMMAND';

/**
 * How a hook of a session runs `cogitator bridge`: the way this process was run, by absolute
 * paths, so the hook works wherever the session's `PATH` points and reaches the same version.
 */
export function bridgeCommandOf(env: NodeJS.ProcessEnv = process.env): string {
  const given = env[BRIDGE_COMMAND_ENV]?.trim();
  if (given) return given;
  const script = process.argv[1];
  return script
    ? `${shellQuote(process.execPath)} ${shellQuote(script)} bridge`
    : 'cogitator bridge';
}

/**
 * The folder of the bridge a session's hooks and tools have to be told: the one a flag or
 * `COGITATOR_BRIDGE_HOME` names, undefined for the default one. A harness does not always hand
 * its environment on (Codex gives a server of tools next to none of it), so a folder that is
 * not the default travels on the command line.
 */
export function bridgeHomeOf(
  env: NodeJS.ProcessEnv = process.env,
  flag?: string
): string | undefined {
  const named = flag?.trim() || env[BRIDGE_HOME_ENV]?.trim();
  return named ? resolve(named) : undefined;
}

/**
 * How a harness starts the bridge's server of tools (`cogitator bridge mcp`): the way this
 * process was run, by absolute paths and without a shell, so it starts whatever `PATH` the
 * harness has. With `COGITATOR_BRIDGE_COMMAND` set, that command line through a shell.
 */
export function bridgeToolsServerOf(
  env: NodeJS.ProcessEnv = process.env,
  home?: string
): ToolsServerCommand {
  const tail = ['mcp', ...(home ? ['--home', home] : [])];
  const given = env[BRIDGE_COMMAND_ENV]?.trim();
  if (given) {
    const line = `exec ${given} ${tail.map((word) => shellQuote(word)).join(' ')}`;
    return { command: 'sh', args: ['-c', line] };
  }
  const script = process.argv[1];
  return script
    ? { command: process.execPath, args: [script, 'bridge', ...tail] }
    : { command: 'cogitator', args: ['bridge', ...tail] };
}

/** Names the agents that take a job only when no other can, when no flag does: `codex,qwen`. */
export const BRIDGE_FALLBACK_ENV = 'COGITATOR_BRIDGE_FALLBACK';

/**
 * The harnesses of last resort: what the flag names, else `COGITATOR_BRIDGE_FALLBACK`, by the
 * words agents are addressed with (`claude` is Claude Code).
 */
export function bridgeFallbackOf(
  env: NodeJS.ProcessEnv = process.env,
  flag: readonly string[] = []
): string[] {
  const named = flag.length > 0 ? flag : (env[BRIDGE_FALLBACK_ENV] ?? '').split(',');
  return [
    ...new Set(
      named.map((word) => word.trim()).flatMap((word) => (word ? [harnessOfAlias(word)] : []))
    ),
  ];
}

/** Names the sandbox of the Codex threads the bridge starts, when no flag does. */
export const BRIDGE_CODEX_SANDBOX_ENV = 'COGITATOR_BRIDGE_CODEX_SANDBOX';

/** The sandboxes `codex exec` knows, the narrowest first. */
export const CODEX_SANDBOXES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const satisfies readonly CodexSandbox[];

/**
 * The sandbox of the Codex threads the bridge starts: what the flag says, else
 * `COGITATOR_BRIDGE_CODEX_SANDBOX`, else undefined for the adapter's own default.
 *
 * @throws UsageError when the name is not a sandbox of Codex
 */
export function codexSandboxOf(
  env: NodeJS.ProcessEnv = process.env,
  flag?: string
): CodexSandbox | undefined {
  const named = flag?.trim() || env[BRIDGE_CODEX_SANDBOX_ENV]?.trim();
  if (!named) return undefined;
  const sandbox = CODEX_SANDBOXES.find((known) => known === named);
  if (sandbox) return sandbox;
  throw new UsageError(`"${named}" is not a sandbox of Codex`, [
    `Use one of: ${CODEX_SANDBOXES.join(', ')}`,
  ]);
}

/** Names the permission mode of the Claude Code sessions the bridge starts, when no flag does. */
export const BRIDGE_CLAUDE_MODE_ENV = 'COGITATOR_BRIDGE_CLAUDE_MODE';

/** The permission modes `claude --permission-mode` knows. */
export const CLAUDE_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

/**
 * The permission mode of the Claude Code sessions the bridge starts: what the flag says, else
 * `COGITATOR_BRIDGE_CLAUDE_MODE`, else undefined for the adapter's own default.
 *
 * @throws UsageError when the name is not a permission mode of Claude Code
 */
export function claudeModeOf(
  env: NodeJS.ProcessEnv = process.env,
  flag?: string
): (typeof CLAUDE_MODES)[number] | undefined {
  const named = flag?.trim() || env[BRIDGE_CLAUDE_MODE_ENV]?.trim();
  if (!named) return undefined;
  const mode = CLAUDE_MODES.find((known) => known === named);
  if (mode) return mode;
  throw new UsageError(`"${named}" is not a permission mode of Claude Code`, [
    `Use one of: ${CLAUDE_MODES.join(', ')}`,
  ]);
}

export interface BridgeAdapterSettings {
  /**
   * The folder of the bridge the adapters work for, when a flag named one: the sessions they
   * start are told it, so they call the same dispatcher and not the default one
   */
  home?: string;
  /** The sandbox of the Codex threads the bridge starts, from `--codex-sandbox` */
  codexSandbox?: string;
  /** The permission mode of the Claude Code sessions the bridge starts, from `--claude-mode` */
  claudeMode?: string;
  /** Hears what an adapter could not do outside a call, such as a report it could not send */
  onError?: (error: Error) => void;
}

/**
 * The adapters of the harnesses the command line reaches: Claude Code and Codex.
 *
 * @throws UsageError when the sandbox named for Codex or the permission mode named for Claude
 * Code is not one they know
 */
export function bridgeAdapters(
  env: NodeJS.ProcessEnv = process.env,
  settings: BridgeAdapterSettings = {}
): BridgeAdapter[] {
  const { home, onError } = settings;
  const scoped = home ? { ...env, [BRIDGE_HOME_ENV]: resolve(home) } : env;
  const bridgeCommand = bridgeCommandOf(env);
  const toolsServer = bridgeToolsServerOf(env, bridgeHomeOf(env, home));
  const sandbox = codexSandboxOf(env, settings.codexSandbox);
  const permissionMode = claudeModeOf(env, settings.claudeMode);
  return [
    claudeCodeAdapter({
      env: scoped,
      bridgeCommand,
      toolsServer,
      ...(permissionMode && { permissionMode }),
    }),
    codexAdapter({
      env: scoped,
      bridgeCommand,
      toolsServer,
      ...(sandbox && { sandbox }),
      ...(onError && { onError }),
    }),
  ];
}

/** The harnesses `cogitator bridge install` knows, by the word the command line takes. */
export const INSTALL_TARGETS = ['claude', 'codex'] as const;

export type InstallTarget = (typeof INSTALL_TARGETS)[number];

/** What a person calls each of them. */
export const INSTALL_LABELS: Record<InstallTarget, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * How each harness is set up for the sessions a person opens, and how that is undone: with the
 * server of tools and the hooks as this process would run them.
 */
export function bridgeSetups(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<BridgeAdapterSettings, 'home'> = {}
): Record<InstallTarget, AdapterSetup> {
  const bridgeHome = bridgeHomeOf(env, settings.home);
  const toolsServer = bridgeToolsServerOf(env, bridgeHome);
  return {
    claude: claudeSetup({
      env,
      toolsServer,
      bridgeCommand: bridgeCommandOf(env),
      ...(bridgeHome && { bridgeHome }),
    }),
    codex: codexSetup({ env, toolsServer }),
  };
}
