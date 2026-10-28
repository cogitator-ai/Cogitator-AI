---
'@cogitator-ai/server-shared': minor
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/express': minor
'@cogitator-ai/fastify': minor
'@cogitator-ai/hono': minor
'@cogitator-ai/koa': minor
'@cogitator-ai/next': minor
'@cogitator-ai/tetsu': minor
'@cogitator-ai/app-server': patch
---

AG-UI 1.0 on every server adapter, and three new kinds of stream events: data parts, run state and step resets.

AG-UI:

- Every adapter serves `POST /agents/:name/agui`: it takes an AG-UI `RunAgentInput` and streams the run as AG-UI events, so CopilotKit or an `@ag-ui/client` `HttpAgent` runs a Cogitator agent as it is. Next.js gets the same as `createAGUIHandler(cogitator, agent)`. The AG-UI thread is the run's memory thread, the last message (the user's) is the new turn, `state` is the run's state and `context` its brief. Auth, `authorizeThread`, `anonymous` and `deps` apply as on the other routes.
- Text, reasoning, tool calls and results map one to one. Tool progress and data parts become activities (`ACTIVITY_SNAPSHOT`, then `ACTIVITY_DELTA` patches), state changes `STATE_DELTA`, foreground subagents and agents used as tools AG-UI subagents, workflow nodes steps.
- A paused run ends with `RUN_FINISHED` and outcome `interrupt`, one `Interrupt` per approval or question, and the next request answers them all at once with `resume` entries. A cancelled question ends the paused run with outcome `cancelled`.
- `@cogitator-ai/server-shared/agui` holds it: `toAGUI()` and `AGUITranslator` turn our stream events into AG-UI events, `streamAGUIRun()` runs or resumes an agent for a request, `runAGUIConformance()` checks an adapter's route. The translation is tested with the AG-UI client's own event verifier, and `HttpAgent` against the routes. `@ag-ui/core` 1.0.3 is a new dependency of `@cogitator-ai/server-shared`.
- Not yet: frontend tools, `MESSAGES_SNAPSHOT`, encrypted reasoning and the binary transport.

Stream events:

- `data`: a tool sends its client structured data with `context.data({ name, data, id?, transient? })`, which returns the part's id. A later part with the same id replaces it in place, a transient one is never kept with the message. The run reports them to `onData`, and a delegated run passes them to its stream.
- `state-snapshot` and `state-delta`: `RunOptions.state` is the state a run starts from, a tool reads and replaces it with `context.state`, the run reports each change to `onState`, and the stream sends a snapshot first and JSON Patches (RFC 6902) after. `createJsonPatch` and `applyJsonPatch` come from `@cogitator-ai/server-shared/json-patch`, a subpath a browser bundle can import.
- `reset-step`: with `onStepReset` on a run, a model that fails mid-answer now moves to the next of the agent's `fallbackModels` instead of failing the run, and a streamed answer that came out empty is asked again, both telling the callback to take back what the step streamed. `AgentStreamSession` sets it unless `resetSteps: false` and sends `reset-step` with the step's parts and tool calls.
- `useCogitatorChat` keeps data parts in `message.data` (transient ones only reach `onData`), the state in `state` (and `onStateChange`), and takes a reset step out of the message.

All of it is additive: a stream only carries the new events when a tool sends data or state, or a fallback model takes over mid-answer. A client that validates events with an older `StreamEventSchema` refuses the new types, so update it along with the server. The app-server's generated client knows the new events.
