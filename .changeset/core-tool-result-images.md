---
'@cogitator-ai/core': patch
---

Tool results that carry a base64 image (`image` or `imageBase64`, such as browser screenshots and generated images) now reach the model as an image instead of a JSON string full of base64. Anthropic, Bedrock, Google, OpenAI Responses and Ollama attach it to the tool result; OpenAI Chat Completions, which takes only text in tool messages, follows the turn's tool messages with one user message holding the images.
