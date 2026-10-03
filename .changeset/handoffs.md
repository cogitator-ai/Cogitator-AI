---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
---

Agents hand conversations over to each other. `handoffs: [billing, support]` (or `{ agent, toolName, description }`) gives an agent `transfer_to_<name>` tools; when the model calls one, the rest of the run goes on as the target agent — instructions, tools, model, reasoning — with the whole conversation. `RunResult.handoffs` and `finalAgent` tell the app which agent answered, `onHandoff` reports each handoff, and a run that pauses for approval after a handoff resumes in the agent it was handed to.
