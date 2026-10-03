---
'@cogitator-ai/core': minor
---

Cost routing budgets (`costRouting.budget`) are enforced on every run, not only with `autoSelectModel`: the run is checked against an estimate for the agent's own model. `autoSelectModel` now picks only models of providers the runtime can call (configured in `llm.providers`, `llm.backends`, a plugin, `llm.defaultProvider` or the agent's own provider) and keeps the agent's model when none fits. New `CostAwareRouter.recommendAvailableModel()` and `checkRunBudget()`.
