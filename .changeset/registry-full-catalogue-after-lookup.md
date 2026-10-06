---
'@cogitator-ai/models': patch
'@cogitator-ai/core': patch
---

`initializeModels()` loads the full model catalogue even after a price lookup ran first. A lookup before it loaded the built-in models and marked the registry initialized, so a later `initializeModels()` did nothing, models outside the built-in list (DeepSeek, Groq, Mistral, Together, Bedrock and more) stayed unpriced, their runs reported `usage.cost: 0` and a cost-routing budget never counted them. Overlapping `initialize()` calls now share one load, and with a `budget` configured the runtime warns once per model whose calls it cannot price.
