---
'@cogitator-ai/core': patch
---

A tool call cut off at the token limit never runs. A streamed Anthropic or Bedrock turn that hit `max_tokens` in the middle of a `tool_use` ran the tool with `{}`, so a tool whose parameters are all optional ran with its defaults. Such a turn now ends the run with `truncated: true` on every backend, streamed or not, and the cut-off call is not kept in the thread. A finished turn whose streamed tool arguments are not valid JSON fails with `LLM_INVALID_RESPONSE`, as it already did without streaming.
