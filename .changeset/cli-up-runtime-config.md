---
'@cogitator-ai/cli': patch
---

`cogitator up` treated every `./cogitator.yml` as an assistant config, so in a project from create-cogitator-app (whose `cogitator.yml` is an `@cogitator-ai/config` runtime config) it failed with assistant validation errors. A runtime config is now recognised: `up` starts the project's Docker Compose services, or explains what the file is when there are none, and `cogitator daemon` no longer picks it as the entry to run.
