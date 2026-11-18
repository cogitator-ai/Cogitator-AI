# Bridge Examples

The agent bridge of `@cogitator-ai/bridge` (experimental): sessions of different harnesses hand each other jobs, ask questions on the way and report back, without waiting for each other.

## Prerequisites

```bash
pnpm install && pnpm build
```

Every example but the second needs no model and no API key: they show the protocol between the sessions, the tools agents call it with, how leave for a call is decided, how a job is done in a worktree of its own, what a job is handed over with, how a recipe has a job done, reviewed and fixed, and how agents debate a question, and play every side themselves. The second runs an agent on a model: Ollama with `qwen2.5:0.5b` by default (`ollama pull qwen2.5:0.5b`), or any model named in `EXAMPLE_MODEL`.

## Examples

| #   | File                 | Description                                                                                                          |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 01  | `01-two-sessions.ts` | A job from hand-over to report: inbox, question and answer, a held-back repeat, verification, a push                 |
| 02  | `02-hosted-agent.ts` | An agent of the runtime takes a job through the bridge: its answer comes back as the job's report                    |
| 03  | `03-tools.ts`        | The tools `cogitator bridge mcp` serves, called the way Codex and Claude Code call them                              |
| 04  | `04-permissions.ts`  | Leave for a call: decided by the rules of the project, by the agent that handed the job over, or by the person       |
| 05  | `05-worktree.ts`     | A job in a git worktree of its own: what it changed, the checks the bridge runs, and taking the work                 |
| 06  | `06-memory.ts`       | What a job is handed over with: its context, the lines of its files, the notes of the board, and what the job taught |
| 07  | `07-recipes.ts`      | A recipe: the bridge has a job done, reviewed by an agent of another harness and fixed, and reports once             |
| 08  | `08-debate.ts`       | A debate: two agents answer each other until they agree, and a third sums it up                                      |

## Running

```bash
npx tsx examples/bridge/01-two-sessions.ts
npx tsx examples/bridge/02-hosted-agent.ts
npx tsx examples/bridge/03-tools.ts
npx tsx examples/bridge/04-permissions.ts
npx tsx examples/bridge/05-worktree.ts
npx tsx examples/bridge/06-memory.ts
npx tsx examples/bridge/07-recipes.ts
npx tsx examples/bridge/08-debate.ts
```

The examples run their own dispatcher on a throwaway folder. For the dispatcher of your machine, which reaches Claude Code and Codex sessions in their own windows:

```bash
cogitator bridge install
cogitator bridge serve
cogitator bridge doctor
cogitator bridge log --follow
cogitator bridge asks
```
