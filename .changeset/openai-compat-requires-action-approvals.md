---
'@cogitator-ai/openai-compat': minor
---

Runs no longer complete when a server tool waits for approval, and no longer time out while the client works on `requires_action`.

- A server tool that needs approval puts the run in `requires_action` with the call, instead of completing it with the model's text from before the call and `required_action: null`. The submitted output decides it: `{"approved": true}` or `approve` runs the tool, anything else declines it (with the output or `reason` as the reason). A configured `guardrails.onToolApproval` still decides server tools without asking the client.
- Client-side `function` calls pause the agent run instead of holding it open, so the run timeout (120 s by default) no longer fails a run whose client answers within the 10 minute `expires_at`, and a waiting run no longer holds a `maxConcurrentRuns` slot. Tool call ids in `required_action` are now the model's own call ids.
