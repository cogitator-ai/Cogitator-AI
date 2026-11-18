---
'@cogitator-ai/studio': patch
---

The overview counts the spend of every agent run once, also when the workflow or swarm that started it has no usage of its own. Before, the finished agents of a running workflow showed no cost and no tokens, and their spend never reached the totals when the workflow failed because the host went away, the studio stopped during it, or an agent finished after its workflow failed.
