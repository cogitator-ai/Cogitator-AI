---
'@cogitator-ai/bridge': patch
---

Every step of the `plan` recipe now tells the agent to report with the report tool of the bridge. A draft was asked for "as the report of this job", and a Claude Code session read that as its final answer: it wrote the plan in its own window and ended its turn, and the recipe waited for a report nobody sent.
