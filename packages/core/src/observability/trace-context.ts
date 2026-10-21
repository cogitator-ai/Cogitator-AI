import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { TraceParent } from '@cogitator-ai/types';

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ALL_ZERO = /^0+$/;

function randomHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString('hex');
    if (!ALL_ZERO.test(hex)) return hex;
  }
}

/** A new W3C trace id: 16 random bytes as lowercase hex, never all zeros. */
export function newTraceId(): string {
  return randomHex(16);
}

/** A new W3C span id: 8 random bytes as lowercase hex, never all zeros. */
export function newSpanId(): string {
  return randomHex(8);
}

/** Whether `id` is a valid W3C trace id. */
export function isTraceId(id: string): boolean {
  return TRACE_ID.test(id) && !ALL_ZERO.test(id);
}

/** Whether `id` is a valid W3C span id. */
export function isSpanId(id: string): boolean {
  return SPAN_ID.test(id) && !ALL_ZERO.test(id);
}

/**
 * `parent` with lowercase ids, its parent span left out when it is not a span id, or `undefined`
 * when its trace id is not a trace id: a run never joins a trace it cannot name.
 */
export function normalizeTraceParent(parent: TraceParent | undefined): TraceParent | undefined {
  if (!parent) return undefined;
  const traceId = parent.traceId.trim().toLowerCase();
  if (!isTraceId(traceId)) return undefined;
  const parentSpanId = parent.parentSpanId?.trim().toLowerCase();
  return { traceId, ...(parentSpanId && isSpanId(parentSpanId) && { parentSpanId }) };
}

/**
 * The trace context of a W3C `traceparent` header (`00-<trace id>-<span id>-<flags>`), the span
 * becoming the parent of what joins it, or `undefined` for a header that is not one.
 */
export function parseTraceparent(header: string): TraceParent | undefined {
  const parts = header.trim().toLowerCase().split('-');
  if (parts.length < 4) return undefined;
  const [version, traceId, spanId, flags] = parts;
  if (!/^[0-9a-f]{2}$/.test(version) || version === 'ff') return undefined;
  if (version === '00' && parts.length !== 4) return undefined;
  if (!/^[0-9a-f]{2}$/.test(flags)) return undefined;
  if (!isTraceId(traceId) || !isSpanId(spanId)) return undefined;
  return { traceId, parentSpanId: spanId };
}

/** A W3C `traceparent` header naming `spanId` of `traceId` as the parent, sampled. */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

const scope = new AsyncLocalStorage<TraceParent>();

/** The trace context work started now joins: set while a run's tools execute. */
export function currentTraceContext(): TraceParent | undefined {
  return scope.getStore();
}

/** Runs `work` with `context` as the trace context that runs started inside it join. */
export function withTraceContext<T>(context: TraceParent, work: () => T): T {
  return scope.run(context, work);
}
