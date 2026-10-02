---
'@cogitator-ai/core': patch
---

Google backend: send tool results that are JSON arrays or plain values as `{ result: … }`. Gemini expects `functionResponse.response` to be an object and rejected an array with `400 Proto field is not repeating`, so any tool that returned a list broke the run.
