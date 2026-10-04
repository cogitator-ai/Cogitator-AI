---
'@cogitator-ai/core': patch
---

Memory failures are no longer dropped silently. Adapters report most failures as a failed `MemoryResult` rather than by throwing, and the runtime only caught throws, so a history entry the store refused (for example every tool call turn on Postgres) was lost without a warning and `onMemoryError` was never called. Failed `addEntry`, `getThread`, `createThread` and history `getEntries` results are now logged and passed to `onMemoryError` (`'save'` or `'load'`), and the run still goes on, as documented.
