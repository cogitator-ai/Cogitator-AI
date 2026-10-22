---
'@cogitator-ai/server-shared': minor
'@cogitator-ai/express': minor
'@cogitator-ai/fastify': minor
'@cogitator-ai/hono': minor
'@cogitator-ai/koa': minor
---

Stream protocol events as Zod schemas and OpenAPI components, and `/agents/:name/resume/stream` in every REST adapter

`@cogitator-ai/server-shared` exports a Zod schema for every stream event (`StreamEventSchema`, a discriminated union on `type`, and `StartEventSchema` through `SwarmEventSchema`, `RunUsageSchema`, `PendingApprovalSchema`), so a client can check what a server sends. The schemas have the shapes of the `StreamEvent` types, an unknown event type fails to parse and a field a newer server adds is dropped. `streamEventComponents()` turns them into OpenAPI 3.0 components, and `generateOpenAPISpec` now documents every SSE route as `text/event-stream` with the `StreamEvent` schema, a `oneOf` with a discriminator on `type`. The `RunUsage`, `PendingApproval`, `StreamStartEvent` and `StreamFinishEvent` components keep their names. `documentStreamEvents(document)` adds the same to a document another generator built: Fastify's Swagger document uses it, and a Tetsu document built with `openapi()` can go through it too. `truncated` and `iterationLimitReached` of `AgentRunResponse` and `StreamFinishEvent` are now documented as `true` when present, which is all a server ever sends. `ToolResultEvent.result`, `WorkflowEvent.data` and `SwarmEvent.data` are optional, as on the wire, where a tool that returned nothing sends no `result`.

Express, Fastify, Hono and Koa serve `POST /agents/:name/resume/stream`, which Tetsu already had: it takes the body of `/resume`, refuses the same requests before the stream opens, and streams the rest of the run like `/stream`. A thread with no paused run ends the stream with an `error` event, `RUN_NOT_PAUSED`.

The conformance cases now cover `/resume/stream`, and check every event of a stream against `StreamEventSchema`, so an adapter of your own that runs them needs the route.
