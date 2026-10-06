---
'@cogitator-ai/a2a': patch
'@cogitator-ai/ai-sdk': patch
'@cogitator-ai/browser': patch
'@cogitator-ai/channels': patch
'@cogitator-ai/cli': patch
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
'@cogitator-ai/swarms': patch
'@cogitator-ai/test-utils': patch
'@cogitator-ai/tetsu': patch
'@cogitator-ai/types': patch
'@cogitator-ai/voice': patch
'@cogitator-ai/wasm-tools': patch
'@cogitator-ai/worker': patch
'@cogitator-ai/workflows': patch
---

CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
