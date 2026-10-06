---
'@cogitator-ai/memory': patch
'@cogitator-ai/core': patch
'@cogitator-ai/channels': patch
'@cogitator-ai/cli': patch
'create-cogitator-app': patch
---

Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.
