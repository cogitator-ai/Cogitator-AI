---
'@cogitator-ai/core': patch
---

Time-travel checkpoints are consistent about the tool call they are anchored on: `messages` stop before that call's result, like `toolResults` (and `createFromTrace` no longer includes the pending step's result). `checkpointAll`, `checkpointEvery` and replay step counts count tool calls only, `divergedAt` and `stepsReplayed` use the same numbering, and a live replay keeps the checkpoint's history when its messages have no system message.
