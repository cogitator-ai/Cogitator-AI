---
'@cogitator-ai/memory': patch
'@cogitator-ai/channels': patch
'@cogitator-ai/workflows': patch
'@cogitator-ai/next': patch
---

- memory: the SQLite adapter and the core facts store create the directory of their database file.
- channels: the file-tool path guard now comes from `@cogitator-ai/core`.
- workflows: `functionNode` takes the output type of its function, so `stateMapper` is typed by it.
- next: `setThreadId(undefined)` starts a new thread.
