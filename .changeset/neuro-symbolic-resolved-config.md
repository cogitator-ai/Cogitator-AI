---
'@cogitator-ai/types': patch
'@cogitator-ai/neuro-symbolic': patch
---

`NeuroSymbolic.getConfig()` returns `ResolvedNeuroSymbolicConfig`, where every section (`logic`, `constraints`, `planning`, `knowledgeGraph`) is present, as it always was at runtime; callers no longer need optional chaining to read it.
