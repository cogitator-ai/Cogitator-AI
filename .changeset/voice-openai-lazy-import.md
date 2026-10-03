---
'@cogitator-ai/voice': patch
---

`openai` is an optional peer dependency, but importing `@cogitator-ai/voice` loaded it eagerly, so the package failed to import without it even when only Deepgram, ElevenLabs or realtime providers were used. `OpenAISTT` and `OpenAITTS` now load `openai` on first use and report how to install it when it is missing.
