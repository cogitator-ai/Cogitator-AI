# AG-UI Examples

Serve Cogitator agents to AG-UI 1.0 frontends, such as CopilotKit or an `@ag-ui/client` `HttpAgent`, through the `POST /agents/:name/agui` route every server adapter has.

## Prerequisites

```bash
pnpm install && pnpm build
ollama pull qwen2.5:0.5b  # or set EXAMPLE_MODEL, such as google/gemini-3.5-flash-lite with GOOGLE_API_KEY in .env
```

## Examples

| #   | File                | Description                                                                                                                             |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | `01-agui-server.ts` | An Express server and an `HttpAgent` in one script: AG-UI events, a tool that asks a question, the resume, shared state and a data part |

## Running

```bash
npx tsx examples/agui/01-agui-server.ts
```

The script prints every AG-UI event of the run: `RUN_STARTED`, the text and the tool call, then `RUN_FINISHED` with outcome `interrupt` when the tool asks for a size. The resume answers every interrupt at once, the tool changes the cart (`STATE_DELTA`) and sends a receipt (`ACTIVITY_SNAPSHOT`), and the script prints the state and the messages the client ended with.

The example runs on `qwen2.5:0.5b` by default, which may answer without calling the tool: set `EXAMPLE_MODEL` to a larger model to see the interrupt and the resume.

See [AG-UI](https://cogitator.app/docs/integrations/ag-ui) for the event mapping.
