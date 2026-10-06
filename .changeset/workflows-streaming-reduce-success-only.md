---
'@cogitator-ai/workflows': patch
---

A streaming reduce (`reduce.streaming: true`) with `successOnly: false` now reduces every item, failed ones included, as the non-streaming reduce does. Its condition skipped every item instead, so the result was the initial accumulator.
