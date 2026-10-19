---
'@cogitator-ai/a2a': patch
'@cogitator-ai/ai-sdk': patch
'@cogitator-ai/browser': patch
'@cogitator-ai/channels': patch
'@cogitator-ai/config': patch
'@cogitator-ai/core': patch
'@cogitator-ai/deploy': patch
'@cogitator-ai/evals': patch
'@cogitator-ai/express': patch
'@cogitator-ai/fastify': patch
'@cogitator-ai/hono': patch
'@cogitator-ai/koa': patch
'@cogitator-ai/mcp': patch
'@cogitator-ai/memory': patch
'@cogitator-ai/models': patch
'@cogitator-ai/neuro-symbolic': patch
'@cogitator-ai/next': patch
'@cogitator-ai/openai-compat': patch
'@cogitator-ai/rag': patch
'@cogitator-ai/redis': patch
'@cogitator-ai/sandbox': patch
'@cogitator-ai/self-modifying': patch
'@cogitator-ai/server-shared': patch
'@cogitator-ai/studio': patch
'@cogitator-ai/swarms': patch
'@cogitator-ai/test-utils': patch
'@cogitator-ai/tetsu': patch
'@cogitator-ai/types': patch
'@cogitator-ai/voice': patch
'@cogitator-ai/wasm-tools': patch
'@cogitator-ai/worker': patch
'@cogitator-ai/workflows': patch
'create-cogitator-app': patch
---

Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
