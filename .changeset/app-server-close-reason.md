---
'@cogitator-ai/app-server': patch
---

`AppServerClient.close()` takes an optional reason that requests still waiting, and any made after, reject with. A transport that sees the server process exit can close the client with the exit code and the end of its stderr instead of the generic "The app-server client is closed".
