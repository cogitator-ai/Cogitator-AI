---
'@cogitator-ai/self-modifying': minor
---

No more model `'default'`. Components called their LLM with the literal model name `'default'` when none was given, which every backend except Google rejected with a 404, and a checkpoint without a model switched the running agent to it. **Breaking:** `GapAnalyzer`, `ToolGenerator` and `ParameterOptimizer` require `model`; `ToolValidator` and `CapabilityAnalyzer` require it when they call an LLM; `SelfModifyingAgent` requires the agent to set a model; `llmChat()` takes a required `model`. Rollback keeps the current model when a checkpoint has none.
