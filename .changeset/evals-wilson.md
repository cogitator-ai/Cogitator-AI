---
'@cogitator-ai/evals': minor
---

`wilsonCI(successes, total)` gives the Wilson score confidence interval of a share, such as a pass rate. Unlike a bootstrap of the same outcomes it keeps its width when every trial went the same way: 10 passes out of 10 give 0.72 to 1, not 1 to 1.
