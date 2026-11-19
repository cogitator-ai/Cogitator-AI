---
'@cogitator-ai/bridge': patch
---

A job no longer stays `working` until its deadline when the session that carries it out ends its turn without a report and cannot be woken, such as a Claude Code session started in a project where `cogitator bridge install` was never run. Once its harness has listed it out of a turn for `limits.reportReminderMs`, with no waiter and no call to the bridge meanwhile, the job fails as silent, saying the session ended its turn without a report and cannot be reminded. Sessions with a waiter are reminded as before.
