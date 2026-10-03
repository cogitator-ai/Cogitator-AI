---
'@cogitator-ai/ai-sdk': patch
---

The AI SDK backend reports the wrapped model's provider name without casting it to the built-in provider union, now that backends can name their own provider.
