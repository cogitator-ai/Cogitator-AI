---
'@cogitator-ai/cli': minor
'@cogitator-ai/bridge': patch
---

`cogitator bridge serve` hosts agents of the Cogitator runtime on any model as members of the bridge.

- `serve --agent <name>=<model>` (repeatable, or `COGITATOR_BRIDGE_AGENTS`) runs a coding agent on that model under a word of its own: `--agent qwen=ollama/qwen3-coder:30b`. Other agents hand it jobs like any other: `delegate qwen`, `build qwen --by claude`, a seat in a race or a debate.
- Every job gets a session of its own, which works in the folder of the job, changes files there without asking and asks through the bridge for every other call.
- The providers and their keys come from the config file `-c, --config` names, the one of the folder `serve` runs in, or the environment. `cogitator daemon start --bridge` reads the same variable.
- A turn that fails on the rate limit or the quota of the provider hands the job to another agent, and with `--fallback <name>` such an agent takes a job only when the others cannot.
- `@cogitator-ai/bridge` exports `HarnessNameSchema`.
