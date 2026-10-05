---
'@cogitator-ai/workflows': patch
---

Subworkflows now inherit the parent run's approval store, approval notifier and timer store. A human (approval) node inside a subworkflow can be answered through the parent's store, and durable timers in a child persist where the parent's do.
