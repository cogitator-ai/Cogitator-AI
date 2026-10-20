---
'@cogitator-ai/mcp': patch
---

Require `@modelcontextprotocol/sdk` 1.32.1 or later. Earlier versions did not tie experimental tasks to the session that created them, and their HTTP client transports and OAuth requests followed cross-origin redirects while re-sending custom headers and request bodies.
