import { claudeCodeAdapter, codexAdapter, type BridgeAdapter } from '@cogitator-ai/bridge';

/** Says how sessions run the bridge's command line, when it is not how this process was run. */
export const BRIDGE_COMMAND_ENV = 'COGITATOR_BRIDGE_COMMAND';

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * How a hook of a session runs `cogitator bridge`: the way this process was run, by absolute
 * paths, so the hook works wherever the session's `PATH` points and reaches the same version.
 */
export function bridgeCommandOf(env: NodeJS.ProcessEnv = process.env): string {
  const given = env[BRIDGE_COMMAND_ENV]?.trim();
  if (given) return given;
  const script = process.argv[1];
  return script ? `${quote(process.execPath)} ${quote(script)} bridge` : 'cogitator bridge';
}

/** The adapters of the harnesses the command line reaches: Claude Code and Codex. */
export function bridgeAdapters(env: NodeJS.ProcessEnv = process.env): BridgeAdapter[] {
  return [claudeCodeAdapter({ env, bridgeCommand: bridgeCommandOf(env) }), codexAdapter({ env })];
}
