---
'@cogitator-ai/memory': minor
---

`CompactionConfig.summaryModel` and `summaryPrompt` were ignored by `CompactionService`. The summarizer now receives them as a second `options` argument (`{ model, prompt }`, type `SummarizeOptions`). The Ollama embedding config schema now keeps `dimensions` and the Google one keeps `baseUrl`, matching the TypeScript types.
