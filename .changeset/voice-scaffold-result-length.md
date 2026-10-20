---
'create-cogitator-app': patch
---

The voice helper of a scaffolded project passes each tool's `maxResultLength` on to the realtime session, so a tool reads as much of its result in a voice call as in a run.
