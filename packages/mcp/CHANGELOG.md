# @cogitator-ai/mcp

## 19.2.4

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 19.2.3

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 19.2.2

### Patch Changes

- 7e42e10: `MCPServer.registerTools` and `serveMCPTools` accept a `readonly Tool[]`, so frozen arrays, `as const` lists and toolsets typed as readonly can be served without copying.
- 7e42e10: `serveAgents` / `agentTools` added the `<agent>_resume` tool for any agent that had a tool with `requiresApproval` set, even `requiresApproval: false`. The resume tool is now added only when a tool can actually ask for approval (`requiresApproval: true` or a check function).
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0

## 19.2.1

### Patch Changes

- db8ebaf: Server handler types match what the server accepts: a resource's `read` may leave out `uri` (it defaults to the URI that was read) through `MCPResourceReadContent`, and a prompt's `get` may return plain string content through `MCPPromptReplyMessage`. The client's `MCPResourceContent` and `MCPPromptMessage` keep their complete shapes.
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 19.2.0

### Minor Changes

- 997e911: `serveAgents(cog, agents, config)` serves Cogitator agents as MCP tools in one call — stdio for Claude Desktop, Cursor and Claude Code, or HTTP with `auth` for remote, per-user use; `agentTools()` returns the same tools for your own `MCPServer`. Tools that need approval are asked from the person at the client through MCP elicitation (`MCPToolContext.elicit`); clients without it get a paused answer and an `<agent>_resume` tool. `MCPServer` gains `sessions: true` (a session per client over HTTP, which server-to-client requests need; a session belongs to the caller that started it).

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 19.1.0

### Minor Changes

- 8bdf656: `MCPServer` authenticates HTTP callers. The new `auth(request)` option returns the caller (`{ userId, scopes, metadata }`) or `undefined` to answer 401; the caller's `userId` reaches tools as `context.userId`, and resource `read` and prompt `get` handlers receive the caller as a second argument. `Authorization` is allowed in CORS requests. With an MCP client per user, connected with that user's token, one agent acts for each user on your own MCP server — see `examples/mcp/03-per-user-mcp.ts`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 19.0.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 19.0.0

### Major Changes

- @modelcontextprotocol/sdk 1.31.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 18.0.0

### Major Changes

- Resumed the unfinished 2026-07-26 audit at step 4. Main fixes: callTool now throws MCPToolError for isError results, where it used to return the error text as a success. Protocol errors and tool failures are no longer retried with backoff. Concurrent calls share one reconnect, the abort signal and timeout are passed through, and close() always closes the transport, so stdio children no longer leak. jsonSchemaToZod no longer drops arguments for object schemas without properties, and now handles type arrays, nullable, const and additionalProperties; an invalid regex pattern no longer breaks getTools. On the server: the tool's full Zod schema goes to the SDK (no double transforms or lost modifiers), image/audio/resource content passes through, prompts and resources propagate errors as JSON-RPC errors, prompts without arguments work, logging goes to stderr so it no longer corrupts stdio JSON-RPC, start() rejects on EADDRINUSE instead of hanging, stop() closes keep-alive connections, and getPort() was added. New tests use the real SDK over HTTP instead of mocks.

  **Breaking changes**
  - MCPClient.callTool throws MCPToolError when the server returns isError: true (previously returned the error text)
  - callTool returns structuredContent when present and null for empty results (previously the raw protocol envelope)
  - mcpContentToResult unwraps a single non-text block instead of returning a one-element array
  - MCPServer resource read / prompt get handler errors are now JSON-RPC errors instead of fake 'Error: ...' content/messages
  - MCPServer logging writes to stderr instead of stdout

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 17.0.11

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 17.0.10

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 17.0.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 17.0.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 17.0.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 17.0.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 17.0.5

### Patch Changes

- fix(mcp): audit — 6 bugs fixed, +28 tests, v17.0.5
  - Fix missing exports: toolSchemaToMCP, mcpContentToResult, resultToMCPContent, serveMCPTools, StdioTransportConfig, HttpTransportConfig
  - Fix createHttpTransport ignoring headers config
  - Fix timeout timer leak on successful connection
  - Fix unregister methods silently failing after server start (now throws)
  - Move @types/node to devDependencies
  - Add 28 new tests (88 total)

## 17.0.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 17.0.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 17.0.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 17.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 16.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 14.1.0

### Minor Changes

- feat(mcp): add server-side resources and prompts support

  Add full MCP specification compliance for MCPServer with:
  - registerResource() for static and dynamic (templated) resources
  - registerPrompt() for reusable prompt templates with arguments
  - Support for URI templates like 'memory://thread/{id}'
  - Batch registration methods: registerResources(), registerPrompts()
  - Getter methods: getRegisteredResources(), getRegisteredPrompts()
  - Unregister methods: unregisterResource(), unregisterPrompt()

## 14.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 13.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 10.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 9.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 8.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 8.1.0

### Minor Changes

- DX Improvements - Phases 1-3

  Phase 1: Foundation
  - Added comprehensive JSDoc documentation to core public APIs
  - Extended config schema with memory, sandbox, reflection, guardrails, costRouting, logging

  Phase 2: Critical Fixes
  - ThreadManager: Added persistent storage with InMemoryThreadStorage, RedisThreadStorage, PostgresThreadStorage
  - SSE Streaming: EventEmitter-based real-time streaming for openai-compat
  - MCP Retry: Exponential backoff with auto-reconnect and connection recovery

  Phase 3: Polish
  - New examples: memory-persistence, openai-compat-server, mcp-integration, constitutional-guardrails

## 8.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 7.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 6.0.1

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 6.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 5.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 4.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 1.1.0

### Minor Changes

- Add MCPClient tests (connect, capabilities, tools, resources, prompts)
- Add MCPServer tests (register, start/stop, logging)
- Add HTTP server shutdown support in stop() method
- Remove redundant type casts in MCPServer

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
