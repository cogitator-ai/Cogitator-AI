---
'@cogitator-ai/ai-sdk': minor
---

Remove the `AISDKModelWrapperOptions` type. No function ever accepted it (`fromAISDK` and `AISDKBackend` take only the AI SDK model, and its `defaultModel` had no effect), so code that imported it can drop the import.
