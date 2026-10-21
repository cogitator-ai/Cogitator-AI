import type { RunObserver } from '@cogitator-ai/types';

const registered: RunObserver[] = [];

/**
 * Watches every run of every `Cogitator` in this process, next to each runtime's own
 * `observers`, from now until the returned function is called: one place to send all telemetry
 * to, whoever builds the runtimes (a server adapter, a workflow, a swarm). Decisions and the spans
 * of workflows and swarms reach it too. `cogitator.close()` does not close it: whoever registers
 * an observer closes it.
 */
export function registerTelemetry(observer: RunObserver): () => void {
  registered.push(observer);
  return () => {
    const index = registered.indexOf(observer);
    if (index !== -1) registered.splice(index, 1);
  };
}

/** The observers registered with `registerTelemetry`, in order. */
export function telemetryObservers(): readonly RunObserver[] {
  return [...registered];
}
