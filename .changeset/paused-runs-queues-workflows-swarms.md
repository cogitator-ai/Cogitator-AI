---
'@cogitator-ai/worker': minor
'@cogitator-ai/workflows': minor
'@cogitator-ai/swarms': patch
---

An agent run that pauses for tool approvals no longer passes for a finished run in queues, workflows and swarms.

- Worker agent jobs complete with `status: 'paused'`, the waiting calls and the checkpoint, and `JobQueue.resumeAgentJob(agentConfig, pausedResult, { decisions })` continues the run on any worker. Workflow and swarm jobs whose agent pauses fail without retries with an `AgentRunPausedError` instead of handing the model's text before the tool call to the next node.
- `agentNode` asks for the waiting calls through the workflow's human-in-the-loop approval store (the `approvalStore` execute option, shaped by the new `approvals` option) and resumes the run once they are answered. Without a store, or with `approvals: false`, the node fails with an `AgentRunPausedError` that carries the checkpoint, and the executor does not retry it.
- A swarm turn that pauses, local or distributed, fails with an `AgentRunPausedError` instead of answering with the pre-tool text. It is not retried, skipped or failed over and does not trip the circuit breaker.
