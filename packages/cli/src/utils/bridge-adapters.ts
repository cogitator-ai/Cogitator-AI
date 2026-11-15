import { resolve } from 'node:path';
import {
  claudeCodeAdapter,
  codexAdapter,
  shellQuote,
  type BridgeAdapter,
} from '@cogitator-ai/bridge';
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
 * The adapters of the harnesses the command line reaches: Claude Code and Codex. `home` is the
 * folder of the bridge they work for when a flag named one: the sessions they start are told it,
 * so they call the same dispatcher and not the default one.
 */
export function bridgeAdapters(
  env: NodeJS.ProcessEnv = process.env,
  home?: string
): BridgeAdapter[] {
  const scoped = home ? { ...env, [BRIDGE_HOME_ENV]: resolve(home) } : env;
  const bridgeCommand = bridgeCommandOf(env);
  return [
    claudeCodeAdapter({ env: scoped, bridgeCommand }),
    codexAdapter({ env: scoped, bridgeCommand }),
  ];
}
