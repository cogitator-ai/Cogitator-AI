---
'@cogitator-ai/next': patch
---

A `signal` returned from `beforeRun` no longer replaces the request's own signal in `createAgentHandler` and `createResumeHandler`, so a client that disconnects still stops the run and its model and tool calls. The run stops on whichever of the two aborts first.
