---
'@cogitator-ai/core': patch
---

`getGuardrails()`, `setConstitution()`, `getCostRouter()` and `getCostSummary()` work before the first run. The guardrails are built from `guardrails.model` or `llm.defaultModel` when one is set; a constitution set earlier is applied when the first run builds them.
