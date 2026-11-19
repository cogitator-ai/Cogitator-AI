---
'@cogitator-ai/test-utils': patch
---

`MockLLMBackend` estimates `usage.inputTokens` from the request as it was sent. With a delay configured, `chat()` and `chatStream()` counted the messages array after the delay, so messages the caller appended meanwhile were counted too.
