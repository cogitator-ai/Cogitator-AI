---
'@cogitator-ai/swarms': patch
---

Distributed swarm turns run on the model the agent would use in-process. The coordinator sent `provider: 'ollama'` for every agent whose model had no built-in provider prefix, so a worker ran `openrouter/deepseek/deepseek-v4-pro` as `ollama/openrouter/...` instead of on its `openrouter` backend. The job payload now carries the agent's model as is, prefixed with the agent's own `provider` only when the agent sets one (an explicit provider gets the model string unchanged, as in-process), and `SerializedSwarmAgentConfig.provider` is optional.
