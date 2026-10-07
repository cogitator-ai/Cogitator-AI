---
'@cogitator-ai/cli': minor
---

New commands: `cogitator add` grows a scaffolded project with rag, mcp, workflows, evals, memory, deploy and the rest, merging into files you changed and refusing with a diff when it cannot; `cogitator dev` opens Cogitator Studio; `cogitator mcp` serves the bundled docs and the project's registry to Claude Code, Cursor and Codex; `cogitator doctor` checks that a project can run; `cogitator eval` runs eval suites for CI. `cogitator init` generates the `channels` preset of create-cogitator-app. Every command now exits `0`, `1` or `2` (wrong command line), reports failures with hints on stderr (stack traces with `COGITATOR_DEBUG`), prints JSON with `--json` (now also on `models`, `status` and `deploy`), and ends its help with examples.

**Breaking:**

- Errors and warnings go to stderr, and a wrong command line (unknown option, missing argument, invalid value) exits with `2` instead of `1`. Scripts that read errors from stdout or check for `1` need to follow.
- `cogitator init` generates a different project: the agent moves from `src/agent.ts` to `src/agents/assistant.ts` and the registry `src/cogitator.ts`, and `src/index.ts` starts the gateway for `dev` and `start`. `src/gateway.ts` still exports `gateway`, so `cogitator assistant`, `build` and `daemon` work as before. Existing projects are not touched.
