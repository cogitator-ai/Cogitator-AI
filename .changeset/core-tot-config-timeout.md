---
'@cogitator-ai/core': patch
---

`ThoughtTreeExecutor` ignored `ToTConfig.timeout`; only `explore(..., { timeout })` stopped the search. The configured timeout is now the default, and a timeout passed to `explore()` still takes precedence.
