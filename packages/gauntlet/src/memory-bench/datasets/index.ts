import type { BenchConversation, BenchDatasetId } from '../types.js';
import { loadBeam } from './beam.js';
import { loadLocomo } from './locomo.js';
import { loadLongMemEvalS } from './longmemeval.js';
import { loadLongMemEvalV2Small } from './longmemeval-v2.js';
import { loadMemoryAgentBenchConflicts } from './memory-agent-bench.js';

export const DATASETS: readonly BenchDatasetId[] = [
  'longmemeval-s',
  'beam-100k',
  'beam-500k',
  'beam-1m',
  'mab-conflict',
  'lme-v2-small',
  'locomo',
];

/** The conversations of a dataset, downloaded into the cache on first use. */
export function loadDataset(
  id: BenchDatasetId,
  log?: (line: string) => void
): Promise<BenchConversation[]> {
  switch (id) {
    case 'longmemeval-s':
      return loadLongMemEvalS(log);
    case 'beam-100k':
      return loadBeam('100K', log);
    case 'beam-500k':
      return loadBeam('500K', log);
    case 'beam-1m':
      return loadBeam('1M', log);
    case 'mab-conflict':
      return loadMemoryAgentBenchConflicts(log);
    case 'lme-v2-small':
      return loadLongMemEvalV2Small(log);
    case 'locomo':
      return loadLocomo(log);
  }
}
