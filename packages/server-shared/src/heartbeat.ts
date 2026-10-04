/**
 * How often adapters write an SSE comment on an open stream, in milliseconds.
 *
 * Well under the shortest idle timeout a stream meets in practice: Bun closes a
 * connection that stays silent for 10 seconds (`Bun.serve` `idleTimeout`), and
 * proxies such as nginx close one after 60. A run waiting on a slow tool or model
 * would otherwise be cut off mid-stream.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 5_000;

/** The frame of a heartbeat: an SSE comment, which every SSE client skips */
export function encodeHeartbeat(): string {
  return ': keep-alive\n\n';
}

/**
 * Reads the `sseHeartbeatMs` option of an adapter: the default when it is not set,
 * `0` to turn heartbeats off, or a positive number of milliseconds.
 *
 * @throws RangeError for a negative, fractional or non-finite value
 */
export function resolveSseHeartbeatMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SSE_HEARTBEAT_MS;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `sseHeartbeatMs must be 0 (off) or a positive whole number of milliseconds, got ${value}`
    );
  }
  return value;
}

/**
 * Calls `beat` every `intervalMs` until the returned function is called, or until
 * `beat` returns `false` (the stream it writes to is gone). An interval of `0`
 * starts nothing.
 */
export function startHeartbeat(beat: () => boolean, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (!beat()) clearInterval(timer);
  }, intervalMs);
  return () => clearInterval(timer);
}
