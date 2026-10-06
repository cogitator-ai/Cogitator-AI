---
'@cogitator-ai/a2a': minor
---

`message/stream` responses write a `: keep-alive` comment every `sseHeartbeatMs` (a new `A2AServer` option, 5 seconds by default, `0` turns it off) while the run is silent, so a proxy or Bun's idle timeout no longer cuts a run that waits on a slow tool. The Hono adapter now streams through the same code as the other adapters.
