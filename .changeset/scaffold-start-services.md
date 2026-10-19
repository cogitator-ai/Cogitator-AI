---
'create-cogitator-app': minor
'@cogitator-ai/cli': minor
---

The scaffolder offers to start the project's compose services once the project is created. When the stack has Postgres, Redis, MongoDB, Qdrant, Jaeger or the Ollama container and Docker is running, it asks whether to run `docker compose up --wait` and waits until they are healthy, so the first `dev` finds its database. The Ollama container pulls the model in the background, and the next steps point at `docker compose logs -f ollama-pull` instead of `ollama pull`. An Ollama that already answers at `OLLAMA_BASE_URL` is left alone and the compose one is not started, since it could not take the port. Nothing starts with `--yes`, `--json`, without a TTY, in CI or in a dry run. `cogitator init` makes the same offer and leaves the compose Postgres out when you give a database URL of your own.

`startServices`, `dockerComposeAvailable`, `servicesToStart`, `offerServices` and `isInteractive` are exported. `offerServices` asks at the terminal, so programmatic callers check `isInteractive` first. `ProjectPlan.oneShotServices` names the services that run a task and exit.

`resolveOllamaUrl` now answers with the Ollama the generated project talks to: `OLLAMA_BASE_URL`, which its `cogitator.yml` reads, else `http://localhost:11434`. It no longer reads `OLLAMA_HOST`, the address the Ollama server listens on, which the project ignores. With the common `OLLAMA_HOST=0.0.0.0` the scaffolder used to look for Ollama on port 80 and report a running one as missing.
