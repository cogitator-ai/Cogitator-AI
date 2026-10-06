---
'@cogitator-ai/memory': minor
'@cogitator-ai/types': minor
---

Compaction no longer reorders a thread that is written while the summary is produced. Before, the kept entries were deleted and added again after the summary with new timestamps, so a reply saved during summarization (two quick messages on a channel) ended up before its own question in every later turn. The summary is now dated just before the first kept entry and kept entries are left untouched, with their ids. `addEntry` accepts an optional `createdAt` (the new `NewMemoryEntry` type) for this, honoured by every built-in adapter, and compactions of one thread in a process run one after another.
