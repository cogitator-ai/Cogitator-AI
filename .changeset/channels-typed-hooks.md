---
'@cogitator-ai/types': minor
'@cogitator-ai/channels': minor
---

Gateway hooks are typed per hook name. `HookPayloads` maps every hook to its payload (`MessageReceivedEvent`, `AgentErrorEvent`, `ApprovalResolvedEvent`, ...), so `hooks.on('agent:error', (e) => e.error.message)` type-checks instead of receiving `unknown`; handlers typed with an `unknown` payload are still accepted. The `agent:error` payload now always carries an `Error`. `GatewayConfig.owner`, which the gateway never read, is deprecated in favour of `ownerIds` on `ownerCommands` and `dmPolicy`.
