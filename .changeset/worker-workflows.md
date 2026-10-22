---
'@cogitator-ai/worker': minor
'@cogitator-ai/workflows': minor
'@cogitator-ai/types': minor
---

Workflow jobs in the worker run on the workflow executor with checkpointed retries, jobs take an id for safe re-adds, and workflow and swarm jobs report usage

Workflow jobs run on the `WorkflowExecutor` of `@cogitator-ai/workflows`, now a dependency of the worker, with the same `SerializedWorkflow` graphs and node semantics (agent, transform, condition and parallel nodes, a graph with many roots starting at all of them). Nodes run in rounds, each running at once every node whose nodes before it all settled. A failing node aborts the agent runs next to it and the job fails once they settled.

A workflow job keeps one checkpoint, saved over after every node under the job's id and `runId`, in `WorkerRuntime.checkpoints`, which `WorkerPool` defaults to a `RedisCheckpointStore` in its Redis under `<queue prefix>:<queue name>:workflow-checkpoints`, kept `checkpointTtl` seconds after the last save (7 days by default). A job BullMQ retries goes on from it instead of running its finished agent nodes again. The checkpoint is deleted once the run finished, and once no attempt follows a failure (the last attempt, a cancelled job, a paused agent run), while a job a shutdown stopped keeps it for the worker that takes the job up. `processWorkflowJob` called on its own runs without checkpoints unless `runtime.checkpoints` is given, and then takes `execution.willRetry(error)`. The run keeps its bookkeeping in state keys starting with `__cogitator:`, left out of the output, and input keys, node ids and output keys with that prefix are refused.

`addAgentJob`, `resumeAgentJob`, `addWorkflowJob`, `addSwarmJob` and `addSwarmAgentJob` take a `jobId`: adding a job whose id the queue holds already returns that job instead of adding a second one, also when two adds race, so producers can retry an add. An id the queue removed adds a new job. An empty id, one with `:`, an integer, a name of the queue's own BullMQ keys and an id the queue holds as another kind of job are refused.

`NodeContext.idempotencyKey` (`workflow:<workflowId>:node:<name>:visit:<n>`) stays the same when a node is retried or its run resumed and changes when the workflow comes back to the node, for external APIs that take an idempotency key.

`WorkflowJobResult` and `SwarmJobResult` now always carry `usage` (`JobUsage`: tokens, cost and agent runs, by agent for swarms), so code that builds these results itself has to set it. The metrics count `cogitator_job_tokens_total`, `cogitator_job_input_tokens_total`, `cogitator_job_output_tokens_total` and `cogitator_job_cost_usd_total` of completed jobs by type (`MetricsCollector.recordUsage`).

`RedisCheckpointStore` takes a `ttl` in seconds, for clients with `expire` and `zrangebyscore`. `WorkflowScheduler.runParallelWithCallback` waits for the tasks in flight before it rejects with the first failure, as `runParallel` does, so a per-node checkpointed run no longer fails while nodes next to the failing one still run.
