---
'@cogitator-ai/core': patch
---

Cost-routing budgets hold against what runs really spend. Before, a run was checked once against an estimate of its cost and recorded once it completed, so a run with many tool calls could spend far past `maxCostPerRun`, a failed or cancelled run never counted toward the hourly and daily budget, and runs side by side did not see each other's spending. Now the runtime also checks before every model call: the run's real cost so far against `maxCostPerRun`, and every run's recorded spending against `maxCostPerHour` and `maxCostPerDay`. A run that reaches a limit stops with `BUDGET_EXCEEDED`. Each call's cost is recorded as soon as it is answered, and a budget keeps its records even with `trackCosts: false`. `CostAwareRouter.checkSpent(runCost)` and `BudgetEnforcer.checkSpent(runCost)` expose the check.
