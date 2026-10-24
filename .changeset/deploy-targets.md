---
'@cogitator-ai/deploy': minor
'@cogitator-ai/cli': minor
'@cogitator-ai/types': minor
'@cogitator-ai/config': minor
'create-cogitator-app': minor
---

An Ollama container in the Docker deployment of a project with local models, `cogitator deploy logs`, and the Fly app and organization in the deploy config.

- When the project's models run on a local Ollama (an Ollama model that is not Ollama Cloud among `llm.defaultModel`, `context.summaryModel` and the models of the memory stages, or `memory.embedding` with `provider: ollama`), the docker target's Compose file runs an `ollama` service on a pinned `ollama/ollama` image, with the models in the `ollama-data` volume and a health check. A one-shot `ollama-pull` service pulls the models before the app starts, the chat models and the embedding model (`nomic-embed-text` unless `memory.embedding.model` names another). The models are arguments of the job, never part of its script, and one the volume has already is skipped, so a restart without network still starts. The app waits for both and gets `COGITATOR_OLLAMA_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` set to `http://ollama:11434`, unless `env` or `secrets` set one of them. Redis and Postgres stay as they were.
- `deploy.services.ollama` turns the container on or off. Off, the app reaches the Ollama of the Docker host through `host.docker.internal` as before. `deploy.ollama` sets the `models` to pull (the detected ones when unset), `gpu: true` to reserve the NVIDIA GPUs of the host and the `image`. The analyzer warns when `memory.embedding.baseUrl` would still point at the container's own localhost, and on Fly when Ollama models or `services.ollama` have no Ollama to run on.
- `cogitator deploy logs [service]` shows the logs of the deployment: `docker compose logs` of the deployed stack on the docker target (`-f, --follow`, `-n, --tail`, 100 lines by default, `--timestamps`, one service such as `app` or `ollama-pull`), `flyctl logs --app <app>` on Fly (`--no-tail` unless following). The commands are built as argument lists, and a service name or tail that would read as a flag is refused. `Deployer.logsCommand()` and the optional `DeployProvider.logsCommand()` return the command for custom pipelines and providers.
- `deploy.app` names the Fly app, the image name stays the fallback, and `deploy.org` creates a new app with `fly apps create --org <org>`. The config schema and Fly preflight refuse an app name Fly would refuse (lowercase letters, digits and dashes, starting and ending with a letter or digit, 63 characters at most) and an organization that is not a slug. `isFlyAppName` and `isFlyOrgSlug` are exported from `@cogitator-ai/types`.
- The README of a project from `create-cogitator-app` with Ollama and the docker target says that the deployment runs and fills its own Ollama.
