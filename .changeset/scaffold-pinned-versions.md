---
'create-cogitator-app': patch
---

Generated projects pin the `@cogitator-ai/*` packages with a caret to the versions released together with the scaffolder (for example `^0.33.0`) instead of `latest`, so an older cached scaffolder keeps generating code that compiles and a reinstall without a lockfile does not pull in an incompatible release.
