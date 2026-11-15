import {
  hostBridge,
  isBridgeError,
  type BridgeAdapter,
  type BridgeHost,
} from '@cogitator-ai/bridge';
import { bridgeAdapters } from './bridge-adapters.js';
import { BRIDGE_HOST_ENV } from './daemon.js';
import { log } from './logger.js';

/** What `hostBridgeInDaemon` reports through, the CLI logger by default. */
export interface BridgeHostLog {
  info(message: string): void;
  warn(message: string): void;
}

const cliLog: BridgeHostLog = {
  info: (message) => log.dim(message),
  warn: (message) => log.warn(message),
};

/**
 * Hosts the bridge dispatcher inside a daemon started with `--bridge` (which sets
 * `COGITATOR_BRIDGE_HOST=1`). The assistant never depends on it: when another dispatcher already
 * runs on the machine this process just does not host one, and a dispatcher that cannot start
 * is a warning, not a failure. It reaches Claude Code and Codex sessions through `adapters`.
 * Returns the host to close on shutdown, or undefined.
 */
export async function hostBridgeInDaemon(
  env: NodeJS.ProcessEnv = process.env,
  report: BridgeHostLog = cliLog,
  adapters?: readonly BridgeAdapter[]
): Promise<BridgeHost | undefined> {
  if (env[BRIDGE_HOST_ENV] !== '1') return undefined;
  try {
    const onError = (error: Error): void => report.warn(`Bridge: ${error.message}`);
    const host = await hostBridge({
      env,
      adapters: adapters ?? bridgeAdapters(env, { onError }),
      onError,
    });
    report.info(`Bridge dispatcher hosted here (socket ${host.paths.socket})`);
    void host.stopped.then((reason) => {
      if (reason === 'lost') report.warn('Bridge: another dispatcher took over, this one stopped');
      if (reason === 'failed') report.warn('Bridge: the dispatcher stopped, its store failed');
    });
    return host;
  } catch (error) {
    if (isBridgeError(error) && error.code === 'already_running') {
      report.info(`${error.message}, this daemon does not host one`);
      return undefined;
    }
    report.warn(
      `The bridge dispatcher could not start: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}
