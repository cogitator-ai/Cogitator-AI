---
'@cogitator-ai/core': patch
'@cogitator-ai/types': patch
---

A streamed run with only `onReasoning` now streams. The runtime streamed only when `onToken` was passed, so a caller that wanted the reasoning as it arrives, and not the answer tokens, got it all at the end in `result.reasoning`. `stream: true` with either callback streams now.
