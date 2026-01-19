---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/memory': patch
---

feat: add vision / multi-modal support

Message content now supports images in addition to text:

- `MessageContent` = `string | ContentPart[]`
- `ContentPart` can be `text`, `image_url`, or `image_base64`

All LLM backends updated to handle multi-modal content:

- **OpenAI**: `image_url` parts with detail level support
- **Anthropic**: `image` source with URL or base64
- **Google Gemini**: `inlineData` and `fileData` parts
- **Ollama**: `images` array with base64 data
