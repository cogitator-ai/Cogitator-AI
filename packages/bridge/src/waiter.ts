import { BridgeClient } from './client.js';
import { isBridgeError } from './errors.js';
import { MAX_WAIT_MS } from './inputs.js';
import type { CallerIdentity, RenderedLetter } from './types.js';

export interface WaitForMailOptions {
  socketPath: string;
  /** The session whose mail is waited for */
  caller: CallerIdentity;
  /** How long to wait in all, a day at most */
  timeoutMs: number;
  /** How often to look for a dispatcher that does not run, 2 s by default */
  retryMs?: number;
  /** Ends the wait early */
  signal?: AbortSignal;
}

export interface WaitForMailResult {
  /**
   * Why the wait ended: `letters` came, the time ran out (`timeout`), another waiter of the
   * session took over (`replaced`), or `signal` aborted (`closed`)
   */
  reason: 'letters' | 'timeout' | 'replaced' | 'closed';
  letters: RenderedLetter[];
  /**
   * Tells the bridge the letters reached the session. Call it once they are where the session
   * reads them: until then they stay queued, and the next waiter gets them again
   */
  confirm(): Promise<void>;
}

const DEFAULT_RETRY_MS = 2_000;

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Waits at the dispatcher for a session's mail, as the process a hook of the session runs. A
 * dispatcher that does not run, or stops while the waiter waits, is waited for too: the session
 * stays reachable across a restart of the dispatcher.
 *
 * @throws BridgeError what the dispatcher refuses the session for, other than not running
 */
export async function waitForMail(options: WaitForMailOptions): Promise<WaitForMailResult> {
  const { signal } = options;
  const deadline = Date.now() + Math.min(options.timeoutMs, MAX_WAIT_MS);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const none = async () => undefined;

  for (;;) {
    const left = deadline - Date.now();
    if (signal?.aborted) return { reason: 'closed', letters: [], confirm: none };
    if (left <= 0) return { reason: 'timeout', letters: [], confirm: none };

    let client: BridgeClient;
    try {
      client = await BridgeClient.connect({
        socketPath: options.socketPath,
        caller: options.caller,
      });
    } catch (error) {
      if (!isBridgeError(error) || error.code !== 'not_running') throw error;
      await pause(Math.min(retryMs, left), signal);
      continue;
    }

    const onAbort = () => void client.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const waited = await client.wait({ timeoutMs: left });
      if (waited.reason === 'letters') {
        const ids = waited.letters.map((letter) => letter.id);
        const connection = client;
        return {
          reason: 'letters',
          letters: waited.letters,
          confirm: async () => {
            try {
              await connection.delivered(ids);
            } finally {
              await connection.close();
            }
          },
        };
      }
      await client.close();
      if (waited.reason !== 'closed') return { reason: waited.reason, letters: [], confirm: none };
    } catch (error) {
      await client.close().catch(() => undefined);
      if (!isBridgeError(error) || error.code !== 'not_running') throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    await pause(Math.min(retryMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/** The text a waiter hands its session: the letters, oldest first, each under its signature. */
export function mailText(letters: readonly RenderedLetter[]): string {
  return letters.map((letter) => letter.text.trimEnd()).join('\n\n');
}
