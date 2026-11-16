import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeDispatcher } from './dispatcher.js';
import { BridgeError } from './errors.js';
import type { BridgeLimitsInput } from './guards.js';
import { bridgePaths, type BridgePaths } from './paths.js';
import { BRIDGE_PROTOCOL_VERSION, type DispatcherInfo } from './protocol.js';
import { serveBridge, type BridgeServer } from './server.js';
import { SqliteBridgeStore } from './store/sqlite.js';
import type { Lease } from './store/store.js';
import type { BridgeAdapter } from './adapter.js';
import type { PersonRoute, RightsJudge } from './person.js';

export interface HostBridgeOptions {
  /** The folder of the bridge's files: `COGITATOR_BRIDGE_HOME` by default, else `~/.cogitator/bridge` */
  home?: string;
  env?: NodeJS.ProcessEnv;
  adapters?: readonly BridgeAdapter[];
  limits?: BridgeLimitsInput;
  /**
   * What the rules of the agent that handed a job over say of a call the one carrying it out
   * asks leave for, `settingsRights()` of `@cogitator-ai/bridge/rights` to read them from the
   * project's permission settings. Without it every such call is the person's to decide
   */
  rights?: RightsJudge;
  /** How a letter that waits for the person reaches them. Without it nothing can wait for them */
  person?: PersonRoute;
  /** How often the dispatcher says it is alive and looks at what time did to jobs, 5 s by default */
  tickMs?: number;
  /**
   * How old the heartbeat of another dispatcher may be for it to still count as alive, four
   * ticks by default. A dispatcher whose process is gone is replaced at once
   */
  leaseTtlMs?: number;
  /** Hears what went wrong outside a call */
  onError?: (error: Error) => void;
}

/** Why a host stopped. */
export type BridgeStopReason = 'closed' | 'lost' | 'failed';

/** A dispatcher running in this process. */
export interface BridgeHost {
  readonly dispatcher: BridgeDispatcher;
  readonly paths: BridgePaths;
  readonly info: DispatcherInfo;
  /**
   * Resolves when the host stops: `closed` after {@link BridgeHost.close}, `lost` when another
   * dispatcher took the store over (this process was asleep too long), `failed` when the store
   * could no longer be written to
   */
  readonly stopped: Promise<BridgeStopReason>;
  /** Stops serving, waits for what is being handled and lets the next dispatcher in */
  close(): Promise<void>;
}

const DEFAULT_TICK_MS = 5_000;
const LEASE_TICKS = 4;

/** The version of this package, as its package.json says. */
export function bridgeVersion(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed;
      if (typeof version === 'string') return version;
    }
  } catch {
    return '0.0.0';
  }
  return '0.0.0';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs the bridge's dispatcher in this process: opens the store, takes its lease, serves the
 * socket and keeps time. One dispatcher runs per machine, and the store decides which: the
 * second one to start is refused while the first is alive.
 *
 * @throws BridgeError `already_running` when another dispatcher holds the store, with the
 * holder in `data.holder`
 */
export async function hostBridge(options: HostBridgeOptions = {}): Promise<BridgeHost> {
  const paths = bridgePaths({ home: options.home, env: options.env });
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const leaseTtlMs = options.leaseTtlMs ?? tickMs * LEASE_TICKS;
  const onError = options.onError ?? (() => undefined);
  const version = bridgeVersion();

  const store = await SqliteBridgeStore.open(paths.database);
  let lease: Lease;
  let acquiredNonce: string | undefined;
  let server: BridgeServer | undefined;
  let dispatcher: BridgeDispatcher;
  let timer: NodeJS.Timeout | undefined;
  let stop!: (reason: BridgeStopReason) => void;
  const stopped = new Promise<BridgeStopReason>((resolve) => (stop = resolve));
  let shutdown: Promise<void> | undefined;
  const shutDown = (reason: BridgeStopReason): Promise<void> => {
    shutdown ??= (async () => {
      clearInterval(timer);
      const ours = reason === 'closed';
      await server?.close({ abandon: !ours }).catch((error: unknown) => onError(asError(error)));
      await dispatcher.close().catch((error: unknown) => onError(asError(error)));
      try {
        if (ours) store.releaseLease(lease.nonce);
      } catch (error) {
        onError(asError(error));
      }
      store.close();
      stop(reason);
    })();
    return shutdown;
  };
  try {
    const acquired = store.acquireLease(
      { pid: process.pid, nonce: randomUUID(), socket: paths.socket, version },
      { now: Date.now(), ttlMs: leaseTtlMs }
    );
    if (!acquired.acquired) {
      throw new BridgeError(
        'already_running',
        `A bridge dispatcher is already running on this machine (pid ${acquired.holder.pid})`,
        { holder: acquired.holder }
      );
    }
    lease = acquired.lease;
    const nonce = lease.nonce;
    acquiredNonce = nonce;
    dispatcher = new BridgeDispatcher({
      store,
      ...(options.adapters && { adapters: options.adapters }),
      ...(options.limits && { limits: options.limits }),
      ...(options.rights && { rights: options.rights }),
      ...(options.person && { person: options.person }),
      onError,
      assertWritable: () => {
        if (store.readLease()?.nonce === nonce) return;
        void shutDown('lost');
        throw new BridgeError(
          'not_running',
          'This bridge dispatcher was replaced by another one. Connect again'
        );
      },
    });
  } catch (error) {
    if (acquiredNonce !== undefined) store.releaseLease(acquiredNonce);
    store.close();
    throw error;
  }

  const info: DispatcherInfo = {
    pid: process.pid,
    version,
    protocol: BRIDGE_PROTOCOL_VERSION,
    startedAt: new Date(lease.acquiredAt).toISOString(),
    socket: paths.socket,
    database: paths.database,
  };
  try {
    server = await serveBridge({ dispatcher, socketPath: paths.socket, info, onError });
  } catch (error) {
    store.releaseLease(lease.nonce);
    store.close();
    throw error;
  }

  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking || shutdown) return;
    ticking = true;
    try {
      let renewed: boolean;
      try {
        renewed = store.renewLease(lease.nonce, Date.now());
      } catch (error) {
        onError(asError(error));
        void shutDown('failed');
        return;
      }
      if (!renewed) {
        onError(new Error('Another bridge dispatcher took over, this one stops'));
        void shutDown('lost');
        return;
      }
      await dispatcher.sweep();
    } catch (error) {
      onError(asError(error));
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(() => void tick(), tickMs);
  timer.unref();
  void tick();

  return { dispatcher, paths, info, stopped, close: () => shutDown('closed') };
}
