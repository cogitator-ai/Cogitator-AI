---
'@cogitator-ai/tetsu': minor
---

An `input` of only whitespace is now refused with `422 VALIDATION_FAILED` on run, stream and swarm routes and over the WebSocket. It used to reach the model, which answered and was billed.

Long runs on Bun are no longer cut off. `Bun.serve` closes a connection silent for 10 seconds, but streams sent their keep-alive comment only every 15, so a stream waiting on a slow tool ended with "terminated (other side closed)", and a JSON run did too. Streams now write a heartbeat every 5 seconds (new `sseHeartbeatMs` option, `0` turns it off), and the JSON run routes lift Bun's idle timeout for their own request once the body is validated.
