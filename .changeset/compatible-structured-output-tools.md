---
'@cogitator-ai/core': patch
---

Structured output with tools now works on OpenAI-compatible servers other than OpenAI. When an agent has both tools and a `responseFormat`, requests to such servers (OpenRouter, DeepSeek, Groq, Together, Mistral, vLLM or an `OpenAIBackend` with a custom `baseUrl`) carry the JSON schema as a system-prompt instruction instead of `response_format`. Many of these providers enforced `response_format` from the first turn, so the model answered in JSON without calling its tools, or ignored the schema: through OpenRouter, DeepSeek V4 Pro called the tool in 1 of 5 runs and matched the schema in none, and Qwen 3.8 Flash never matched it. With the schema in the prompt all tested models (DeepSeek, GPT-6 Luna, Qwen, MiMo, GLM) called the tool and matched the schema every time. The official OpenAI API and Azure OpenAI, and every request without tools, still use `response_format`.
