---
'@cogitator-ai/cli': patch
---

Fix `cogitator up` and `cogitator wizard --edit`:

- `up` loads `.env` into `process.env` (without overriding variables already set), so tools that read it, such as `web_search` and `github_api`, see keys written by the wizard.
- `up` supervises the assistant for restarts even without `selfConfig`, so the owner `/restart` command (exit code 78) restarts it instead of stopping it.
- `wizard --edit` keeps a postgres memory config and the WhatsApp/WebChat channels instead of overwriting them.
