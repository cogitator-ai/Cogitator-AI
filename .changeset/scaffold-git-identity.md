---
'create-cogitator-app': patch
---

The initial scaffold commit is now authored by your own git identity instead of a hard-coded `Cogitator <init@cogitator.dev>` address. A neutral `create-cogitator-app@localhost` identity is used only when no `user.name`/`user.email` is configured, so the commit still succeeds on fresh machines.
