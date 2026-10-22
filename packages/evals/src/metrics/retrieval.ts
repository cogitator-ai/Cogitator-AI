import type { MetricFn, MetricOptions, Passage } from './types';
import { passageMatches } from './matching';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function passageOf(item: unknown): Passage | undefined {
  if (!isRecord(item) || typeof item.content !== 'string') return undefined;
  const id =
    typeof item.id === 'string'
      ? item.id
      : typeof item.chunkId === 'string'
        ? item.chunkId
        : undefined;
  return {
    ...(id !== undefined && { id }),
    content: item.content,
    ...(typeof item.score === 'number' && Number.isFinite(item.score) && { score: item.score }),
    ...(typeof item.source === 'string' && { source: item.source }),
  };
}

/**
 * The passages of a tool result shaped like the `rag_search` tool's of `@cogitator-ai/rag`:
 * `{ results: [{ content, chunkId?, score?, source?, ... }] }`, each result's `id` (or else its
 * `chunkId`) as the passage id. Undefined for any other result.
 */
export function ragSearchPassages(toolResult: {
  name: string;
  result: unknown;
}): Passage[] | undefined {
  const payload = toolResult.result;
  if (!isRecord(payload) || !Array.isArray(payload.results)) return undefined;
  return payload.results.flatMap((item) => {
    const passage = passageOf(item);
    return passage ? [passage] : [];
  });
}

function createMetricFn(name: string, fn: MetricFn): MetricFn {
  fn.metricName = name;
  return fn;
}

interface RetrievalFigures {
  expected: readonly string[];
  retrieved: readonly Passage[];
}

/**
 * A retrieval metric over a case's `retrieved` passages and its `expectedPassages`. A case
 * expecting no passages scores 1 when nothing was retrieved and 0 otherwise, and so does a case
 * expecting passages when nothing was retrieved.
 */
function retrievalMetric(
  name: string,
  compute: (figures: RetrievalFigures) => { score: number; details?: string }
): MetricFn {
  return createMetricFn(name, (async (result) => {
    const expected = result.case.expectedPassages;
    if (expected === undefined) {
      return { name, score: 0, details: 'no expected passages provided' };
    }
    const retrieved = result.retrieved ?? [];
    if (expected.length === 0 || retrieved.length === 0) {
      const score = expected.length === retrieved.length ? 1 : 0;
      return {
        name,
        score,
        details:
          score === 1
            ? undefined
            : retrieved.length === 0
              ? 'nothing was retrieved'
              : 'no passages were expected',
      };
    }
    const { score, details } = compute({ expected, retrieved });
    return { name, score, ...(details !== undefined && { details }) };
  }) as MetricFn);
}

/** The share of the expected passages that some retrieved passage matches */
export function retrievalRecall(opts?: MetricOptions): MetricFn {
  return retrievalMetric(opts?.name ?? 'retrievalRecall', ({ expected, retrieved }) => {
    const missing = expected.filter((e) => !retrieved.some((p) => passageMatches(p, e)));
    return {
      score: (expected.length - missing.length) / expected.length,
      details:
        missing.length > 0
          ? `not retrieved: ${missing.map((e) => JSON.stringify(e)).join(', ')}`
          : undefined,
    };
  });
}

/** The share of the retrieved passages that match an expected one */
export function retrievalPrecision(opts?: MetricOptions): MetricFn {
  return retrievalMetric(opts?.name ?? 'retrievalPrecision', ({ expected, retrieved }) => {
    const relevant = retrieved.filter((p) => expected.some((e) => passageMatches(p, e))).length;
    return {
      score: relevant / retrieved.length,
      details:
        relevant < retrieved.length
          ? `${retrieved.length - relevant} of ${retrieved.length} retrieved passages were not expected`
          : undefined,
    };
  });
}

/**
 * The reciprocal rank of the first retrieved passage that matches an expected one: 1 when it
 * came first, 1/2 second and so on, 0 when none matches. Passages rank in the order they came,
 * one tool result after the other.
 */
export function retrievalMRR(opts?: MetricOptions): MetricFn {
  return retrievalMetric(opts?.name ?? 'retrievalMRR', ({ expected, retrieved }) => {
    const rank = retrieved.findIndex((p) => expected.some((e) => passageMatches(p, e))) + 1;
    return {
      score: rank === 0 ? 0 : 1 / rank,
      details:
        rank === 0
          ? 'no retrieved passage was expected'
          : rank > 1
            ? `first expected passage at rank ${rank}`
            : undefined,
    };
  });
}
