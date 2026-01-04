---
'@cogitator-ai/core': minor
'@cogitator-ai/memory': minor
'@cogitator-ai/swarms': patch
'@cogitator-ai/types': minor
---

### Memory improvements

- Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
- Add Google embedding service using `text-embedding-004` model (768 dimensions)
- Implement hybrid context strategy (30% semantic + 70% recent messages)
- Fix foreign key constraint violation when saving entries before thread creation

### Swarms improvements

- Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
- Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
- Fix coordinator to properly register pipeline stages and handle missing negotiation section
