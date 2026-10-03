---
'@cogitator-ai/core': patch
---

`ThoughtTreeExecutor` now sends its own model calls the routed model name (not the `provider/model` id) on the backend of the agent's provider, honours `explorationStrategy` (`beam` runs level by level, `best-first` follows the best-scored branch, `dfs` goes deep first) and `maxIterationsPerBranch`, keeps candidates beyond `beamWidth` so a failed branch backtracks to the next best one, and counts the tokens and cost of branch generation, evaluation and synthesis in `usage` and `stats`.
