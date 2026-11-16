---
'@cogitator-ai/acp': patch
---

`AcpAgentProvider` no longer hangs on an agent that starts but never answers `initialize`, as an agent that is not signed in often does. The new `handshakeTimeout` option (30 seconds by default, `0` for no limit) stops such an agent and fails the turn with an error that names its command. `close()` now ends a start in progress and stops the agent it launched, where it used to wait for the connection forever and leave the agent running. An agent that exits before it answered is reported with its command and exit code instead of "ACP connection closed".
