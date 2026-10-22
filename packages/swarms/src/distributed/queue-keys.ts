/**
 * Keys of the job queue distributed swarms share with their workers. They carry the queue's hash
 * tag, so in a Redis Cluster the queue, the lists of the turns workers run and their heartbeats
 * sit in one slot and BLMOVE and LMOVE work between them.
 */

/**
 * Redis list key that distributed swarm workers consume jobs from.
 */
export function swarmJobQueueKey(keyPrefix = 'swarm', queue = 'swarm-agent-jobs'): string {
  return `${keyPrefix}:jobs:{${queue}}`;
}

/** The keys around one queue */
export interface SwarmQueueKeys {
  /** The list coordinators push jobs to and workers move them from */
  queue: string;
  /** The set of the ids of workers that took jobs from the queue */
  workers: string;
  /** The list of the jobs a worker runs, which it moved off the queue */
  processing(workerId: string): string;
  /** The key a worker keeps alive while it runs, gone once it stopped beating */
  heartbeat(workerId: string): string;
}

export function swarmQueueKeys(keyPrefix = 'swarm', queue = 'swarm-agent-jobs'): SwarmQueueKeys {
  const base = swarmJobQueueKey(keyPrefix, queue);
  return {
    queue: base,
    workers: `${base}:workers`,
    processing: (workerId) => `${base}:processing:${workerId}`,
    heartbeat: (workerId) => `${base}:heartbeat:${workerId}`,
  };
}
