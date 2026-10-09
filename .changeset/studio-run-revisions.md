---
'@cogitator-ai/studio': patch
---

A chat turn no longer sticks at "running" after its run finished. Right after sending, the studio loads the thread, and when that snapshot was taken while the run was still going but arrived after the event that it completed, it took the run back to running for good. Every run now has a `revision` that each change raises, streamed text included, and the UI keeps only the newer copy: a late snapshot no longer undoes an event, and text it already holds is not added twice. Revisions go on above those of a session before a restart.

A run whose fork steps cannot be recorded still completes, without steps, and the studio log says why. It used to stay running.
