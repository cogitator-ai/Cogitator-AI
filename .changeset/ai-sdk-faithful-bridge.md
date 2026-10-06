---
'@cogitator-ai/ai-sdk': minor
'@cogitator-ai/types': minor
---

The AI SDK bridge keeps what used to get lost on the way:

- `finishReason` reports how the agent's run ended: `length` for a truncated answer, `content-filter` for a filtered or refused one, `other` (raw `iteration-limit`) when tool calls used up the iterations, instead of always `stop`.
- `doGenerate` and `doStream` agree: text the agent wrote before a tool call is part of both, and in JSON mode only the final answer is text, so `streamText` with `Output.object` parses like `generateText`.
- Tool calls and results of earlier turns in a multi-turn prompt reach the agent in its transcript.
- `toolChoice: 'none'` runs the agent without tools, a forced tool choice produces a warning.
- `fromAISDK` replays reasoning parts with their provider metadata (Anthropic thinking signatures) and each tool call's provider metadata (`ToolCall.replay.providerMetadata`), sends tool results with images as image content and failed calls as `error-text`, and maps `content-filter` finishes.
- `fromAISDKTool` passes the real tool call id as `toolCallId` and keeps `$defs`, `toAISDKTool` forwards `toolCallId` and shows the model media results as images through `toModelOutput`.
