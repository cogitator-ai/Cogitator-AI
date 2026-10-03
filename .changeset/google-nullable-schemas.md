---
'@cogitator-ai/core': patch
---

The Google backend converts JSON Schema nulls (a Zod `.nullable()` field, or `null` in a `type` array) into Gemini's `nullable: true`, so structured output with nullable fields no longer fails with HTTP 400.
