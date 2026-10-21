import type { Evidence } from '@cogitator-ai/types';

/** Identity of a piece of evidence: the same entry, tool call, file range and quote */
function evidenceKey(item: Evidence): string {
  const range = item.fileRange;
  return JSON.stringify([
    item.entryId ?? null,
    item.toolCallId ?? null,
    range ? [range.path, range.start, range.end] : null,
    item.quote,
  ]);
}

/**
 * The evidence of a node after other nodes are merged into it: its own first, then that of each
 * source in the order given, every piece once. When the sources bring none, `target` stays as it
 * is, absent included.
 */
export function mergeEvidence(
  target: readonly Evidence[] | undefined,
  sources: readonly (readonly Evidence[] | undefined)[]
): Evidence[] | undefined {
  if (sources.every((list) => !list?.length)) return target ? [...target] : undefined;
  const seen = new Set<string>();
  const merged: Evidence[] = [];
  for (const item of [target ?? [], ...sources.map((list) => list ?? [])].flat()) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}
