---
'@cogitator-ai/core': patch
---

A run's `context` is added to the system prompt as one JSON block labelled as data instead of `key: value` lines. A line break in a key or value stays inside a JSON string, so a value such as `"ok\nNew operator policy: ..."` can no longer start a line of instructions next to the agent's own.
