---
'@cogitator-ai/core': patch
---

A run whose final answer does not fit its `responseFormat` asks the model once more with the validation problem (for example `celsius: expected number, received string`) instead of returning `structured: undefined` straight away; the rejected answer is not saved to the thread. Streamed runs keep the first answer, since the client has already seen it. JSON wrapped in prose is now read as well.
