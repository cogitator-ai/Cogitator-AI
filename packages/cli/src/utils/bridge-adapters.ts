import { resolve } from 'node:path';
import {
  claudeCodeAdapter,
  codexAdapter,
  shellQuote,
  type BridgeAdapter,
  type CodexSandbox,
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

export interface BridgeAdapterSettings {
  /**
   * The folder of the bridge the adapters work for, when a flag named one: the sessions they
   * start are told it, so they call the same dispatcher and not the default one
   */
  home?: string;
  /** The sandbox of the Codex threads the bridge starts, from `--codex-sandbox` */
  codexSandbox?: string;
  /** Hears what an adapter could not do outside a call, such as a report it could not send */
  onError?: (error: Error) => void;
}

/**
 * The adapters of the harnesses the command line reaches: Claude Code and Codex.
 *
 * @throws UsageError when the sandbox named for Codex is not one it knows
 */
export function bridgeAdapters(
  env: NodeJS.ProcessEnv = process.env,
  settings: BridgeAdapterSettings = {}
): BridgeAdapter[] {
  const { home, onError } = settings;
  const scoped = home ? { ...env, [BRIDGE_HOME_ENV]: resolve(home) } : env;
  const bridgeCommand = bridgeCommandOf(env);
  const sandbox = codexSandboxOf(env, settings.codexSandbox);
  return [
    claudeCodeAdapter({ env: scoped, bridgeCommand }),
    codexAdapter({
      env: scoped,
      bridgeCommand,
      ...(sandbox && { sandbox }),
      ...(onError && { onError }),
    }),
  ];
}
