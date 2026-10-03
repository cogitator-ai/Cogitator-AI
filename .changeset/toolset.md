---
'@cogitator-ai/core': minor
'@cogitator-ai/browser': patch
---

`toolset(...tools)` returns tools as a typed tuple: still an array an agent accepts, but each element keeps its own parameter and result types, so `const [search] = createMyTools()` calls `search.execute` with search's parameters. `createMemoryTools`, `createSchedulerTools` and the browser's `createNavigationTools`, `createInteractionTools`, `createExtractionTools`, `createVisionTools` and `createNetworkTools` use it; before, their elements were a union whose `execute` accepted nothing.
