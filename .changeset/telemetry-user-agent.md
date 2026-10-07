---
'create-cogitator-app': patch
---

Telemetry events reach Umami. The event's User-Agent ended in `Node/<major>`, which Umami's bot filter takes for a server client, so every event was answered with 200 and dropped. The Node version stays in the event data, and the platform is written the way browsers do, so Umami also shows the OS.
