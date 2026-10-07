---
'@cogitator-ai/core': patch
---

Tool calls now run whatever finish reason the provider reports for them. vLLM, LM Studio, the Gemini OpenAI endpoint and OpenAI with a forced tool answer tool calls with `finish_reason: 'stop'`, and a run on them used to end with an empty `completed` result without calling the tool. Every built-in backend now settles a turn the same way, and the runtime applies the same rule to backends of your own.
