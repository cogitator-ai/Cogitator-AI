---
'@cogitator-ai/channels': patch
---

`DmPolicyMiddleware` now expands a leading `~` in `storePath`. Previously a path like `~/.cogitator/dm-allowlist.json` created a literal `~` directory in the working directory when the middleware was used outside `RuntimeBuilder`.
