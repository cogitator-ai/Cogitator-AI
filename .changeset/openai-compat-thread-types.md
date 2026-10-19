---
'@cogitator-ai/openai-compat': patch
---

`OpenAIAdapter.createThread`, `getThread` and `updateThread` are typed as returning `Thread` for TypeScript projects on `moduleResolution: node16` or `nodenext`. Their declarations pointed at a module path those settings cannot resolve, so the methods came out as `any` there.
