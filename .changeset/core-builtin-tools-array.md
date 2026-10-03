---
'@cogitator-ai/core': patch
---

`builtinTools` is a `Tool[]`, so `new Agent({ tools: builtinTools })` compiles; the readonly tuple it was could not be assigned to `AgentConfig.tools`.
