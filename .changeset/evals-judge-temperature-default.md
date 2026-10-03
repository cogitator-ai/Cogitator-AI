---
'@cogitator-ai/evals': patch
---

Judge configs had to set `temperature` in TypeScript although the schema defines a default, and that default was never applied. `judge` now takes `JudgeConfigInput` with an optional `temperature`, and the suite resolves it to 0 when it is omitted.
