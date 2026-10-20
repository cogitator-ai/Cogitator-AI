---
'@cogitator-ai/ai-sdk': minor
---

`toAISDKTool()` and `convertToolsToAISDK()` take `{ invoker, onApproval }`. With an invoker (your `Cogitator`) every call goes through `cogitator.invokeTool`, so the guardrails, the sandbox of a sandboxed tool and `tool.timeout` apply, and approval works on every AI SDK major. A call the AI SDK asks approval for (`requiresApproval`) and approved through its approval flow (ai@6, ai@7: an approving `tool-approval-response` for the call in the last message) runs without being asked again. Messages usually come from the client, so set `experimental_toolApprovalSecret` to have the AI SDK refuse approvals your server did not sign. Other calls that need approval, every one on ai@4 and ai@5, which do not read `needsApproval`, or one the guardrails want approved, go to `onApproval`, then to `guardrails.onToolApproval`, and a call nobody decides fails with an error the model reads. The AI SDK has parsed the arguments with the tool's schema already, so they are not parsed again.

Without options the AI SDK calls the tool's `execute` directly, as before.
