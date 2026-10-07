---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

Tools can return media with `toolContent(...parts)`: text and image parts reach the model as the content of the tool message (images as image parts), and file parts such as audio stay with the result for the application while the model sees a one-line description. Guardrails that filter tool results read the text and the descriptions instead of base64 data. `toolResultParts()` reads the parts of any result, including objects with a base64 `image` as before.
