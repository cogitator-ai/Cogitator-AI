---
'@cogitator-ai/a2a': minor
---

`A2AServer` and `A2AClient` now speak the A2A protocol v0.3 as specified, so they work with the official A2A SDKs, Google ADK and other v0.3 agents. Every response is checked against the official v0.3.0 JSON schema in the tests, and the official JavaScript SDK client talks to `A2AServer` (and `A2AClient` to an SDK server) in them.

Breaking changes to the wire format and the API:

- Parts, messages, tasks and stream events use `kind`. Messages need a `messageId` (`A2AClient` fills it in), file parts nest the file (`{ kind: 'file', file: { uri | bytes } }`), artifacts have `artifactId`, and `status.message` is an agent message instead of a string (`messageText()` reads it). `errorDetails` is gone.
- Streams send every event as a JSON-RPC response with the request id, start with the task, mark the last status update `final: true` and have no `[DONE]` marker. The reply streams as `artifact-update` chunks (`append`, `lastChunk`) instead of `token` events. A request that fails before the stream starts is answered with a plain JSON-RPC error, and `tasks/resubscribe` reconnects to a running task.
- The Agent Card is served at `/.well-known/agent-card.json` (the old path stays as an alias) with `protocolVersion`, `preferredTransport`, an absolute `url`, skill `tags`, spec security schemes (`in`, `name`) and `supportsAuthenticatedExtendedCard`. `version` is now the agent version (`agentVersion`, default `1.0.0`) and `provider` takes `{ organization, url }`. Card signatures are JWS (HS256) objects in `signatures`.
- Every agent of a server has its own endpoint and card under `<basePath>/<agent>`, so any A2A client reaches it. `A2AClient` reads the card and sends requests to the endpoint it names, and with `agentName` uses that agent's own card.
- Methods follow the specification: `tasks/pushNotificationConfig/{set,get,list,delete}` (configs are `{ url, token, authentication }`, webhooks receive the task with `X-A2A-Notification-Token`) and `agent/getAuthenticatedExtendedCard`. The client methods are `setPushNotificationConfig`, `getPushNotificationConfig`, `listPushNotificationConfigs` and `deletePushNotificationConfig`.
- New tasks start `submitted`. A task in a terminal state can no longer take a message (`-32600`), carry a conversation on with a new message in its `contextId`, whose earlier tasks the agent now gets as context. `sendMessage` returns the task or a direct reply message.
- Error codes follow the specification: `-32007` is the extended card error, an unknown agent is `-32602`. Missing or rejected credentials are answered with HTTP 401.
