---
'@cogitator-ai/deploy': patch
---

Docker preflight checks that BuildKit (`docker buildx`) is available. The generated Dockerfile caches package installs with `RUN --mount=type=cache`, which the legacy builder refuses, so a Docker without the buildx plugin now fails preflight with a fix instead of failing midway through `docker build`.
