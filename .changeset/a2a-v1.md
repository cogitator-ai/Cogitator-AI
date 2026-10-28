---
'@cogitator-ai/a2a': minor
---

A2A 1.0 next to A2A 0.3, on the same server and the same endpoints.

A request names its version in the `A2A-Version` header (or query parameter). A request without one speaks 0.3 as before, byte for byte, so existing 0.3 clients do not notice anything. A request with `A2A-Version: 1.0` gets the 1.0 protocol: the PascalCase methods (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, the four push config methods, `GetExtendedAgentCard`), the ProtoJSON model without `kind`, streams that close on the final state instead of a `final` flag, and errors with `google.rpc.ErrorInfo` and `BadRequest` details. An unsupported version is refused with `-32009`, its ErrorInfo listing the supported ones. The internal task model stays in the 0.3 shape and is translated at the boundary, so `TaskStore`, `RedisTaskStore` and stored tasks are untouched and a task created over one version is readable over the other.

Server:

- The A2A 1.0 HTTP+JSON binding under `restPath` (default `<basePath>/rest`), with the routes of the proto's http bindings, `/{tenant}/` variants, `:cancel` and `:subscribe`, `application/a2a+json` or `application/json` bodies, SSE streams, `201` on create, `204` on delete, and `{ error: { code, status, message, details } }` errors with the HTTP status table of the specification. `A2AServer.handleRest()` serves it for custom integrations.
- Every agent is a tenant: its 1.0 interfaces carry its name, a mismatching tenant is `-32602`, and a task created over 1.0 is visible only through the agent that created it, over 1.0 and 0.3 alike (the new internal metadata key `cogitator:agent`). Tasks created over 0.3 and tasks stored before stay visible to every agent. On REST a first segment that names an agent is read as its tenant first, so an agent may be called `tasks`.
- `ListTasks` pages with a keyset cursor over `TaskStore.list()`: `pageSize` 1 to 100 (default 50), `nextPageToken` empty on the last page, `totalSize`, `statusTimestampAfter`, `includeArtifacts`. The cursor sorts with ties broken by task id, while the stores and the 0.3 `tasks/list` extension with offsets keep their order.
- Agent Cards come from one model per agent: `getV1AgentCard()` next to `getAgentCard()`. Card responses carry `Vary: A2A-Version`, an `ETag` and `Cache-Control: public, max-age=300`, and answer a matching `If-None-Match` with `304`. An agent without tools lists one `chat` skill, so `skills` is never empty, and the extended card is announced in `capabilities.extendedAgentCard`.
- Cards are signed with a private key as A2A 1.0 specifies: `cardSigning: { alg, privateKey, kid, jku?, publishJwks? }` with ES256, RS256, PS256 or EdDSA on `node:crypto` (no new dependency), over the JCS of the 1.0 card, the same payload the official SDK verifies. The 1.0 card and the hybrid card carry the same signature, and `publishJwks` serves the public key at `/.well-known/jwks.json`. A 0.3 or hybrid card verifies only when its 0.3 fields follow from the signed 1.0 form (its `url` and `additionalInterfaces` are signed 0.3 interfaces, its security schemes round-trip without loss), and the signer refuses cards that do not. A client on 0.3 takes its endpoint from the signed 0.3 interface. `cardSigning: { secret }` (HS256) keeps working and is deprecated.
- Extensions: `capabilities.extensions` lists the Cogitator ones (`https://cogitator.app/a2a/extensions/{tool-approvals,interrupts,run-timeout}/v1`) and the new `extensions` option. A message that does not ask for a required one in `A2A-Extensions` (`X-A2A-Extensions` in 0.3) is refused with `-32008`, and the response names the activated ones. Over 1.0 the run timeout comes from `metadata[run-timeout uri].timeoutMs`.
- Push configs remember the version they were registered with. 0.3 webhooks get the task as before, 1.0 webhooks get `{ task }` in the 1.0 form as `application/a2a+json` with `Authorization: <scheme> <credentials>`.
- `A2A_ERROR_CODES` has `extensionSupportRequired` (-32008) and `versionNotSupported` (-32009). `A2AHttpRequest` has an optional `query`. The Fastify plugin parses `application/a2a+json`, the Koa middleware and the Express router read the body themselves (up to 1 MiB, `413` above) when no parser did or a parser left `{}`, and the Next.js handlers work as a catch-all route and export `DELETE`.

Client:

- `A2AClient` reads 0.3 cards, the hybrid card and pure 1.0 cards. `protocolVersion: 'auto'` (default) speaks 1.0 when the card offers it, `'1.0'` and `'0.3'` pin it. `transport: 'JSONRPC' | 'HTTP+JSON'` picks the 1.0 binding, the tenant comes from the chosen interface, and `endpoint()` tells what it chose. The API stays on the 0.3-shaped types.
- `listTasksPage()` for 1.0 `ListTasks`, `extensions` to ask for extensions, and `verifyAgentCard({ keys | resolveKey, trustJku })` for JWS signatures, with a `jku` fetched only from the card's own origin unless `trustJku` names others. `verifyAgentCard(secret)` still checks HS256.

Changed defaults, and how to keep the old behavior:

- The card served without `A2A-Version` is now the hybrid card: the 0.3 card plus `supportedInterfaces` listing every interface of both versions.
- The REST binding is served under `<basePath>/rest`. Turn it off with `restPath: false`. An agent named `rest` keeps its endpoint: the default REST mount is then off, with a warning.
- `A2AClient` speaks 1.0 to a server that offers it, so errors carry 1.0 codes (a message to an ended task is `-32004` instead of `-32600`) and webhooks it registers get the 1.0 payload. Keep a client on 0.3 with `protocolVersion: '0.3'`.
- `protocolVersions: ['0.3']` on the server turns all of 1.0 off: no hybrid card, no REST binding, 0.3 only.
