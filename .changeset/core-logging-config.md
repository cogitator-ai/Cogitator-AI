---
'@cogitator-ai/core': minor
---

`CogitatorConfig.logging` is applied: a runtime created with it sets the process-wide logger (`getLogger()`) to its `level` (now including `'silent'`), `format` and `destination` (`'file'` appends JSON lines to `filePath`). New `createLoggerFromConfig()` builds such a logger directly.
