---
'@cogitator-ai/deploy': minor
---

The generated Dockerfile is a production image: a builder stage with the native toolchain and BuildKit cache mounts, an install from the lockfile, dev dependencies pruned, and a runtime stage on `node:24-alpine` (or Bun) with `tini` as init and the unprivileged `node` user. Start scripts run without their `--env-file` flags, and `file:` / `link:` dependencies are copied in before the install.

A Node app managed by Bun builds on the Node image with Bun copied in and `node-gyp` installed for native modules, and Bun prunes without `--ignore-scripts`, so native dependencies are built in the image. Yarn Plug'n'Play projects get their package archives in the image and the PnP resolver loaded at start, where the image used to copy a `node_modules` that PnP never creates.

**Breaking:** the image runs on `node:24-alpine` instead of `node:22-alpine`, as the unprivileged `node` user with `tini` as PID 1, and `CMD` runs the start command directly, without `--env-file`. Pass the environment to the container (`docker run --env-file`, Fly secrets), and make sure the app writes only to its data volume or `/tmp`.
