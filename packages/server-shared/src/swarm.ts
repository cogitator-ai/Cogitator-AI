/** The part of a `Swarm` that releases what it holds; distributed swarms hold Redis connections */
export interface ClosableSwarm {
  close(): Promise<void>;
}

/**
 * Runs `task` with a swarm the request created, and closes the swarm when the task settles:
 * after success, failure or abort alike.
 *
 * A distributed swarm opens two Redis connections and keeps its state in Redis until it is
 * closed, which also gives that state its expiry (`distributed.cleanupAfter`). A server that
 * built one per request without closing it would leak connections until Redis refuses new
 * clients. Closing an in-process swarm does nothing. A failure to close is logged, not
 * thrown, so it never replaces the run's own result or error.
 */
export async function withSwarm<S extends ClosableSwarm, T>(
  swarm: S,
  task: (swarm: S) => Promise<T>
): Promise<T> {
  try {
    return await task(swarm);
  } finally {
    await swarm.close().catch((error: unknown) => {
      console.warn('[cogitator] Failed to close a swarm:', error);
    });
  }
}

/** The slots of a swarm config that hold agents, as `GET /swarms` reads them */
export interface SwarmAgentSlots {
  supervisor?: { name: string };
  workers?: readonly { name: string }[];
  agents?: readonly { name: string }[];
  moderator?: { name: string };
  router?: { name: string };
  stages?: readonly { agent: { name: string } }[];
  pipeline?: { stages: readonly { agent: { name: string } }[] };
}

/**
 * The names of every agent a swarm runs, in the order the swarm registers them: supervisor,
 * workers, agents, moderator, router, then the pipeline stages. Each name appears once.
 */
export function swarmAgentNames(config: SwarmAgentSlots): string[] {
  const names = [
    config.supervisor?.name,
    ...(config.workers ?? []).map((agent) => agent.name),
    ...(config.agents ?? []).map((agent) => agent.name),
    config.moderator?.name,
    config.router?.name,
    ...(config.stages ?? []).map((stage) => stage.agent.name),
    ...(config.pipeline?.stages ?? []).map((stage) => stage.agent.name),
  ];
  return [...new Set(names.filter((name): name is string => name !== undefined))];
}
