---
'@cogitator-ai/voice': minor
'create-cogitator-app': patch
---

Realtime tools can run through the Cogitator tool invoker. `createRealtimeTools(cogitator, tools, options)` turns Cogitator tools into realtime tools whose calls go through `cogitator.invokeTool`, the way an agent run executes them: arguments checked against the tool's schema, approval asked for calls that need it, the guardrails applied, sandboxed tools run in the sandbox and `tool.timeout` kept. A call that needs approval goes to `options.onApproval`, then to `guardrails.onToolApproval`, and one nobody approves does not run: the model gets an error saying it needs approval. Realtime sessions used to call `execute` directly, so a tool marked `requiresApproval` ran without anyone approving it. The options also set the `agentId`, `userId` and `threadId` (default `voice:<sessionId>`) the tools see.

`RealtimeTool.execute(args, context)` gets the provider's `callId`, the session's `sessionId` (a `VoiceAgent` sets the client id, a `RealtimeSession` takes `sessionId` in its config) and a `signal` that aborts when the session closes or loses its connection. With Gemini it also aborts when Gemini cancels the call (`toolCallCancellation`, sent when the user interrupts), and the cancelled call gets no answer.

The voice project of the scaffolder uses `createRealtimeTools`.

**Migration:** tools written as `execute: async (args) => ...` keep working. Code that calls a `RealtimeTool`'s `execute` itself, such as a test, now passes a context: `{ callId, signal }`.
