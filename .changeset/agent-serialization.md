---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

feat(core): implement Agent serialization and deserialization

Add serialize() and Agent.deserialize() methods for agent persistence:

- AgentSnapshot format with version field for backward compatibility
- Tool names stored instead of full tool objects (functions are not serializable)
- Tool resolution via ToolRegistry or direct array on deserialize
- Config overrides support during restoration
- Agent.validateSnapshot() for runtime type checking
- AgentDeserializationError for clear error messages

This enables:

- Pause/resume agents across process restarts
- Sharing agent configurations as JSON
- Storing agents in databases
