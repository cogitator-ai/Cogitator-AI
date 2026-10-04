---
'@cogitator-ai/core': patch
---

`LangfuseExporter.flush()` and `shutdown()` now wait until Langfuse has received the queued events. They called the Langfuse client's `flush()` and `shutdown()`, which return immediately without waiting, so traces sent just before a process exited could be lost. They now await `flushAsync()` and `shutdownAsync()`. A hand-written type declaration for `langfuse` hid the difference, and it is gone together with the ones for `nodemailer` and `better-sqlite3`: the exporter, the `send_email` tool and the `sql_query` tool are now checked against the real packages' types. Generations no longer send unset `temperature` or `maxTokens` as `undefined` model parameters.
