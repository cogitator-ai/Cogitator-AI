---
'@cogitator-ai/deploy': patch
---

The generated Dockerfile's `HEALTHCHECK` probes `127.0.0.1` instead of `localhost`. In Alpine images `localhost` resolves to the IPv6 `::1` first, so a server listening on `0.0.0.0` (IPv4 only), as the create-cogitator-app API server does in production, refused the probe and Docker marked a healthy container unhealthy.
