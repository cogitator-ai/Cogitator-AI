/**
 * A distributed swarm worker whose agent runs never finish, for tests that kill it while it
 * holds a turn. Reads the Redis url, key prefix and heartbeat interval from the environment and
 * prints `taken <jobId>` once it started a turn.
 */

import { Cogitator, type Agent } from '@cogitator-ai/core';
import { DistributedSwarmWorker } from '@cogitator-ai/worker';
import type { RunOptions, RunResult } from '@cogitator-ai/types';

class HangingCogitator extends Cogitator {
  override run(_agent: Agent, _options: RunOptions): Promise<RunResult> {
    return new Promise(() => {});
  }
}

const worker = new DistributedSwarmWorker(
  {
    redis: { url: process.env.SWARM_REDIS_URL },
    keyPrefix: process.env.SWARM_KEY_PREFIX,
    heartbeatInterval: Number(process.env.SWARM_HEARTBEAT_INTERVAL ?? 200),
    pollTimeout: 0.1,
    cogitator: new HangingCogitator(),
  },
  {
    onJobStarted: (job) => console.log(`taken ${job.jobId}`),
  }
);

await worker.start();
console.log(`started ${worker.getWorkerId()}`);
