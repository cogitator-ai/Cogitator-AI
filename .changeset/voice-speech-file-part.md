---
'@cogitator-ai/voice': minor
---

`speak_text` returns the synthesized audio as a `file` part of a tool content result instead of `{ audioBase64, format }`. The model sees a one-line description and the application reads the audio from the result, so a spoken answer no longer puts tens of thousands of base64 tokens into the next model call.
