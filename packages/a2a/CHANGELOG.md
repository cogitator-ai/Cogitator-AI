# @cogitator-ai/a2a

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.3.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.3.5

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.3.4

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.3.2

### Patch Changes

- fix(a2a): audit — 37 bugs & security fixes, +78 tests

  Security:
  - Timing-safe HMAC comparison (timingSafeEqual)
  - SSRF protection for webhook URLs (validateWebhookUrl)
  - Canonical JSON serialization for card signing
  - Content-Type validation in all adapters
  - Buffer.from for Unicode-safe Basic auth

  Bugs:
  - structuredClone in InMemoryTaskStore.update()
  - Redis SCAN-based key enumeration (was blocking KEYS)
  - Redis mget batch fetch for list operations
  - TTL validation at RedisTaskStore construction
  - SSE multi-line data parsing per spec
  - Race condition fix in streaming (listener before task)
  - Streaming message validation
  - Client agentCard() throws on empty response
  - extractOutputFromTask guards for undefined fields

  Features:
  - allowPrivateUrls config option for local dev/testing
  - InMemoryPushNotificationStore.cleanup() method

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.3.0

### Minor Changes

- Add push notifications, Agent Card signing, and production persistence
  - Push notifications with webhook delivery and HMAC verification
  - Extended Agent Card with authenticated access and capability negotiation
  - Agent Card cryptographic signing and verification
  - RedisTaskStore for production task persistence
  - Token-level streaming in SSE responses

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- 320fe4d: Add @cogitator-ai/a2a — native A2A Protocol v0.3 implementation

  First TypeScript agent runtime with native Google A2A support.
  Zero external dependencies, own implementation from spec.
  - A2AServer: expose any Cogitator Agent as A2A-compliant service
  - A2AClient: connect to remote A2A agents with discovery and streaming
  - asTool() bridge: wrap remote A2A agents as local Cogitator tools
  - Agent Card auto-generation from Agent metadata
  - Task lifecycle management with pluggable TaskStore
  - JSON-RPC 2.0 over HTTPS with SSE streaming
  - Framework adapters: Express, Hono, Fastify, Koa, Next.js
  - 119 tests, 1500 lines of production code
