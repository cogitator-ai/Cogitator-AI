---
'@cogitator-ai/deploy': minor
---

`Deployer.deploy` built the artifacts with its own generator and never called the target provider's `generate()`, so a custom provider's artifacts were ignored. It now deploys what `provider.generate(config, projectDir)` returns. The built-in Docker and Fly providers' `generate()` now detect the package manager, lockfile, build script and start command (new `ProjectAnalyzer.detectBuild`), so their Dockerfile matches what `deploy` produced before instead of assuming pnpm and `dist/server.js`.
