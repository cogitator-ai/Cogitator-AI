# ACP Examples

The Agent Client Protocol of `@cogitator-ai/acp`, both ways: Cogitator agents served to editors, and external ACP agents (Claude Code, Codex, Gemini CLI) run as agents of an app-server host.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY, or use Ollama with --spawn
```

## Examples

| #   | File                   | Description                                                                                   |
| --- | ---------------------- | --------------------------------------------------------------------------------------------- |
| 01  | `01-editor-client.ts`  | What an editor does: initialize, a session, a prompt, its updates and permission questions    |
| 02  | `02-external-agent.ts` | An external ACP agent next to a native agent, its permissions decided by the permission rules |

## Running

```bash
npx tsx examples/acp/01-editor-client.ts
COGITATOR_MODEL=ollama/qwen3:8b COGITATOR_CLI=packages/cli/dist/index.js \
  npx tsx examples/acp/01-editor-client.ts --spawn

npx tsx examples/acp/02-external-agent.ts
npx tsx examples/acp/02-external-agent.ts --agent claude
```
