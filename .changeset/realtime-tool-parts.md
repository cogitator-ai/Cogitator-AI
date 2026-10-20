---
'@cogitator-ai/voice': minor
---

Realtime sessions read tool results made of parts the way a run does. A `toolContent()` result, or an object with a base64 `image`, used to reach OpenAI as a JSON string with the base64 inside and Gemini as the raw object. Both now get the text of the parts, with images and files described, cut to the tool's `maxResultLength` (100 000 characters by default). Other results are sent as before, except one whose JSON is longer than `maxResultLength`, which is cut the same way (as text, for Gemini).

`toolImages: true` on `RealtimeSessionConfig` (or `VoiceAgentConfig`) also sends the images to a model that takes them: OpenAI gets a user message with `input_image` parts after the tool outputs (`gpt-realtime`, `gpt-realtime-2`), Gemini gets `inlineData` parts in the function response (Gemini 3 models). Only PNG, JPEG, GIF and WebP images are sent, others stay described. The message of a tool that throws is cut the same way, and a session refuses a tool whose `maxResultLength` is not a positive integer. It is off by default, since not every realtime model takes images.
