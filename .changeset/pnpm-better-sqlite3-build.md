---
'create-cogitator-app': patch
---

pnpm projects decline the build of better-sqlite3 unless a feature needs it. Every project gets better-sqlite3 through `@cogitator-ai/cli`, and pnpm 11.0 failed the install over its build nobody approved (`ERR_PNPM_IGNORED_BUILDS`). better-sqlite3 ships prebuilt binaries, so the build is not needed. SQLite memory and the assistant harness still allow it.
