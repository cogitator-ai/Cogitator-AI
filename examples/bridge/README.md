# Bridge Examples

The agent bridge of `@cogitator-ai/bridge` (experimental): sessions of different harnesses hand each other jobs, ask questions on the way and report back, without waiting for each other.

## Prerequisites

```bash
pnpm install && pnpm build
```

The first and the third example need no model and no API key: they show the protocol between the sessions and the tools agents call it with, and play every side themselves. The second runs an agent on a model: Ollama with `qwen2.5:0.5b` by default (`ollama pull qwen2.5:0.5b`), or any model named in `EXAMPLE_MODEL`.

## Examples

| #   | File                 | Description                                                                                          |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| 01  | `01-two-sessions.ts` | A job from hand-over to report: inbox, question and answer, a held-back repeat, verification, a push |
| 02  | `02-hosted-agent.ts` | An agent of the runtime takes a job through the bridge: its answer comes back as the job's report    |
| 03  | `03-tools.ts`        | The tools `cogitator bridge mcp` serves, called the way Codex and Claude Code call them              |

## Running

```bash
npx tsx examples/bridge/01-two-sessions.ts
npx tsx examples/bridge/02-hosted-agent.ts
npx tsx examples/bridge/03-tools.ts
```

The examples run their own dispatcher on a throwaway folder. For the dispatcher of your machine, which reaches Claude Code and Codex sessions in their own windows:

```bash
cogitator bridge install
cogitator bridge serve
cogitator bridge doctor
cogitator bridge log --follow
```
