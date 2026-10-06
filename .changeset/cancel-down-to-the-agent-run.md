---
'@cogitator-ai/swarms': minor
'@cogitator-ai/worker': minor
'@cogitator-ai/types': minor
---

Cancellation now reaches the agent runs of swarms and queued jobs.

- `SwarmRunOptions.signal` cancels a swarm run and aborts its agent turns in flight. `swarmNode`, `conditionalSwarmNode` and `parallelSwarmsNode` pass the workflow run's signal, so a node timeout, pause or cancel stops the swarm (it ran to the end before), and a retry of the node no longer fails with "Swarm is already running"
- `WorkerPool` hands the abort signal BullMQ gives each job to its agent runs, workflow nodes and swarm turns. `pool.cancelJob(jobId)` stops a running job, and `stop()` aborts the jobs still running when its timeout runs out instead of letting them run on without a lock while another worker picks them up. The processors take `{ signal }` as a third argument
- Distributed swarm turns that the swarm gave up on no longer run later: every retry of a turn reuses its job id and payload, a timed-out copy still queued is removed before the next push, and an aborted, timed-out or closed turn is taken off the queue and added to a cancelled set that `DistributedSwarmWorker` checks before and while it runs a turn (`cancelCheckInterval`, `onJobCancelled`)
