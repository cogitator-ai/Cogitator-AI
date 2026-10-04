---
'@cogitator-ai/deploy': patch
---

The programmatic `Deployer` now reads the `deploy` section of the project's `cogitator.yml`. Only `cogitator deploy` used to pass it in, so `deployer.plan()` and `deployer.deploy()` ignored a configured `health.path`, `port`, `secrets` and the rest, and the generated Dockerfile `HEALTHCHECK` and Fly.io check probed `/cogitator/health` even on a server mounted elsewhere, which Docker then marked unhealthy. `configOverrides` still win over the file, field by field inside `services`, `env`, `health` and `resources`, and both win over auto-detection.
