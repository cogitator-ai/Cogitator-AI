/** Most calls of a step that run at once with `parallelToolCalls` unless `maxParallelToolCalls` says otherwise */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;

/** How the calls of a step are run, see {@link scheduleToolCalls} */
export interface ToolCallSchedule<T> {
  /** How many calls the step has */
  count: number;
  /** Whether the call at `index` may run at the same time as other safe calls */
  safe: (index: number) => boolean;
  /** Most safe calls that run at once */
  maxParallel: number;
  /** Runs the call at `index` */
  run: (index: number) => Promise<T>;
  /** Whether no call starts after this outcome, such as a call that asked a question */
  stops?: (outcome: T) => boolean;
}

/**
 * Runs the calls of a step: each run of consecutive safe calls as a pool of at most
 * `maxParallel` at once, each other call alone, once every call before it is done, and the calls
 * after it once it is done. After an outcome that `stops`, calls already running finish and no
 * other starts. The outcomes come back in the order of the calls, those of calls that never
 * started left out. The first call that throws rejects the step: calls running go on, no other
 * starts.
 */
export async function scheduleToolCalls<T>(schedule: ToolCallSchedule<T>): Promise<T[]> {
  const { count, safe, run, stops } = schedule;
  const maxParallel = Math.max(1, Math.floor(schedule.maxParallel));
  const outcomes = new Map<number, T>();
  let stopped = false;
  let failed = false;
  const settle = (index: number, outcome: T) => {
    outcomes.set(index, outcome);
    if (stops?.(outcome)) stopped = true;
  };

  for (let index = 0; index < count && !stopped;) {
    if (!safe(index)) {
      settle(index, await run(index));
      index++;
      continue;
    }
    let end = index;
    while (end < count && safe(end)) end++;
    let next = index;
    const worker = async () => {
      while (!stopped && !failed && next < end) {
        const at = next++;
        try {
          settle(at, await run(at));
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxParallel, end - index) }, worker));
    index = end;
  }

  return [...outcomes.entries()].sort(([a], [b]) => a - b).map(([, outcome]) => outcome);
}
