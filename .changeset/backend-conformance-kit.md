---
'@cogitator-ai/test-utils': minor
---

A conformance kit for LLM backends. `backendConformanceCases(target)` runs one set of scenarios through a backend's real SDK against a fake provider that answers in that provider's wire format: an answer, tool calls with a tool stop and with a plain stop, a tool call cut at the token limit, a content filter, an error inside a stream, an abort, and rate limit, quota, authentication, overload, server and context overflow errors. The cases do not depend on a test runner, each `run()` throws an `AssertionError` when the backend breaks the contract.

`startFakeProvider` serves HTTP/1.1 or HTTP/2 without TLS, and wires are included for OpenAI Chat Completions and Responses, Anthropic, Gemini, Ollama and Bedrock Converse, so a backend of your own for an OpenAI-compatible server can be checked with `openAIChatWire`.
