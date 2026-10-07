---
'create-cogitator-app': patch
---

Projects created with 0.5.0 pinned `@cogitator-ai/cli` 0.5 and `@cogitator-ai/core` 0.34, the versions of the release before it, because the scaffolder was built before the version bump. `npm run dev:studio`, `npm run doctor`, `cogitator add` and `cogitator mcp` failed with an unknown command. New projects pin the current packages again, and the scaffolder reports its own version. A project created with 0.5.0 works again once its `@cogitator-ai/*` dependencies are on the latest versions, for example `npm install -D @cogitator-ai/cli@latest @cogitator-ai/test-utils@latest` and `npm install @cogitator-ai/core@latest @cogitator-ai/config@latest`.
