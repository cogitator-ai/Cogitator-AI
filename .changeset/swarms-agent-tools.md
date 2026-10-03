---
'@cogitator-ai/swarms': minor
'@cogitator-ai/types': minor
---

Consensus voters get the `cast_vote`, `get_votes`, `change_vote` and `get_consensus_status` tools automatically (they were never attached, so votes could only be parsed from text). New `agentTools: { messaging, blackboard }` swarm option (and `SwarmBuilder.agentTools()`) gives every agent the built-in messaging and blackboard tools; it is rejected for distributed swarms and when the message bus or blackboard is disabled.
