# @cogitator-ai/a2a

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
