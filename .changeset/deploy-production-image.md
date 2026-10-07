---
'@cogitator-ai/deploy': minor
---

The generated Dockerfile is a production image: a builder stage with the native toolchain and BuildKit cache mounts, an install from the lockfile, dev dependencies pruned, and a runtime stage on `node:24-alpine` (or Bun) with `tini` as init and the unprivileged `node` user. Start scripts run without their `--env-file` flags, and `file:` / `link:` dependencies are copied in before the install.
