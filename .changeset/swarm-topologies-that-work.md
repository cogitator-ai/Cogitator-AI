---
'@cogitator-ai/worker': minor
'@cogitator-ai/swarms': patch
---

Swarm topologies do what they say. The `collaborative` topology of worker swarm jobs ran only the first agent (it mapped to round-robin): now every agent contributes in each of `maxRounds` rounds (default 3), seeing the task and all contributions so far, and the `coordinator`, when given, combines them into the answer. The job reports every contribution in `agentOutputs` and the rounds it ran. Distributed swarms now refuse the hierarchical and negotiation strategies, whose delegation and offer tools only exist in-process, instead of letting the supervisor answer by itself. The JSDoc of `JobQueue.addSwarmAgentJob` no longer claims that distributed swarms use it: their turns go to `DistributedSwarmWorker`.
