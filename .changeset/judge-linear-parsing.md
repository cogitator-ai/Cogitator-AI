---
'@cogitator-ai/evals': patch
---

The LLM judge reads fenced JSON, outer braces and labelled scores with linear scans instead of regexes that could backtrack on crafted judge output. Verdicts parse the same as before.
