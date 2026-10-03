---
'@cogitator-ai/test-utils': patch
---

`MockLLMBackend` records each request as it was sent. The runtime keeps appending to the same messages array, so every recorded call used to show the final conversation.
