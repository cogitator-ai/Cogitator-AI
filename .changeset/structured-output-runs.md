---
'@cogitator-ai/core': minor
---

Structured output now works in runs. `agent.config.responseFormat` was never passed to the LLM backend by `cogitator.run()`, so `json` and `json_schema` agents were only as structured as their prompt, and `RunResult.structured` was never set. The format now reaches every backend on both the streaming and non-streaming paths (Zod schemas become JSON Schema, strict only when the schema allows it), and `result.structured` holds the parsed answer, validated by the schema. Agents with tools keep calling them: older Claude models and Gemini 2.x, which cannot combine a JSON format with tools, get the schema as an instruction instead. `Agent.serialize()` keeps `responseFormat`.
