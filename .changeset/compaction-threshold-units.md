---
'@cogitator-ai/memory': minor
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
'@cogitator-ai/cli': patch
---

`CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.
