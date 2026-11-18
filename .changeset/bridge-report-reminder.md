---
'@cogitator-ai/bridge': patch
---

A session that ends its turn without reporting on its job is reminded to report.

Live runs of the recipes showed a Claude Code session answer in its own window and stop, with its job left in progress until the deadline, four hours by default, and the recipe waiting with it. A session that has waited for mail for `limits.reportReminderMs` (one minute) with a job it carries out and has not reported on now gets a letter that says so, which wakes it. A session that does not react within the reply timeout of the job fails the job with that reason. One that reacts with anything but a report is reminded again no sooner than that timeout. A session is left alone while its harness lists it in the middle of a turn, while it waits for an answer, for a job it handed over or for the person, and while its checks run.
