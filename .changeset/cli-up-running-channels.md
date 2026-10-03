---
'@cogitator-ai/cli': patch
---

The `cogitator up` startup summary listed every configured channel, including ones skipped because their token (e.g. `WEBCHAT_TOKEN`) is missing. It now lists the channels the gateway actually runs, and warns when none are running.
