# @cogitator-ai/evals

## 0.1.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.1.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.5

## 0.1.5

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.1.4

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.3

### Patch Changes

- @cogitator-ai/core@0.18.2

## 0.1.2

### Patch Changes

- fix(evals): audit — 7 bugs fixed, +5 tests
  - csv-loader: replaced blocking `readFileSync` with async `readFile`
  - eval-suite: retry fallback now returns real elapsed duration instead of 0
  - eval-builder: removed duplicate `isLLMMetric` function (now imported from eval-suite)
  - regression: fixed `isLowerBetter` to include `*Duration` and `*Latency` suffix checks
  - regression: `noRegression` now fails when no baseline metrics found in current results (was incorrectly passing)
  - custom: assertion `check()` errors are now caught and returned as `passed: false`
  - statistical: converted index loop to for-of in tokenUsage

  Also removed unused dependencies `@cogitator-ai/types` and `nanoid`.
  Exported `isLLMMetric` as part of public API.
