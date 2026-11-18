---
'@cogitator-ai/bridge': patch
---

The stand-ins of `claude` and `codex` in `@cogitator-ai/bridge/testing` wait for their hooks and commands before a session that is stopped is gone.

- A session that was stopped asked its hooks to end and left at once. A hook that still wrote to its pipes after that, if only the word of its shell on a child the signal killed, died of SIGPIPE before its own handler of the signal had run. On a loaded machine a test saw the hook gone and its cleanup not done.
- A session now stays until its hooks and commands have ended and keeps reading their output until then. One that does not end in three seconds is killed, where it used to be left running.
- While it waits, the session takes no new message and goes no further with the turn it was in, so nothing is changed or recorded after the stop.
