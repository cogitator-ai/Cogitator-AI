---
'@cogitator-ai/cli': patch
---

Projects from `cogitator init` deploy as they are. `init` writes a runtime `cogitator.yml` with the provider, model and memory, and a `deploy` section that runs the gateway as a worker, publishes the WebChat port and lists the API key and channel tokens as secrets, so `cogitator deploy` no longer ships a container without them that restarts forever. The SQLite memory directory is created at start (the first `pnpm dev` failed without it) and lives on a volume when deployed, and `package.json` pins the pnpm, Yarn or Bun version that ran `init` in `packageManager`.

`cogitator deploy -c <file>` reads the model, memory and deploy section from that file instead of mixing it with the default one, finds `.cogitator.yml` like `loadConfig` does, and shows the project kind, volumes and which services Fly does not provision.

`cogitator run` loads the `.env` next to the config file, and with an assistant config from `cogitator wizard` runs its `llm.provider` and `llm.model` instead of silently falling back to a local Ollama model.

`cogitator build` bundles only the project's own code and leaves every package to `node_modules`, so a project with the Docker sandbox (whose `ssh2` dependency ships a native addon) or optional media dependencies builds again.
