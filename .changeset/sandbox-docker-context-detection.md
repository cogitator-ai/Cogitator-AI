---
'@cogitator-ai/sandbox': patch
---

The Docker executor finds the daemon the way the `docker` CLI does: it tries the endpoint of the current Docker context (`DOCKER_CONTEXT` or `~/.docker/config.json`), then the sockets of Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop and rootless Docker, so `isDockerAvailable()` no longer reports `false` when only a non-default context is running.
