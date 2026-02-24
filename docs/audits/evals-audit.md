# Audit: @cogitator-ai/evals

Started: 2026-02-25

## Status

Complete
Last updated: 2026-02-25

## Completed Steps

1. Build — ✅ No issues
2. Lint — ✅ No issues
3. Remove comments — ✅ No comments found
4. Full source review — ✅ 7 bugs fixed:
   - `csv-loader.ts` — `readFileSync` in async function → replaced with `await readFile`
   - `eval-suite.ts:224` — retry fallback returned `duration: 0` → now uses real elapsed time
   - `eval-builder.ts:9` — duplicate `isLLMMetric` removed, imported from `eval-suite.ts`
   - `regression.ts:5` — `isLowerBetter` missing `.endsWith('Duration'/'Latency')` checks → fixed to match `threshold.ts`
   - `regression.ts:26` — `noRegression` returned `passed: true` when no baseline metrics matched current results → now returns `passed: false` with clear message
   - `custom.ts:12` — uncaught error from `opts.check()` would crash eval suite → wrapped in try/catch
   - `statistical.ts:83` — index-based loop replaced with for-of for consistency
5. Exports check — ✅ All public API exported; added `isLLMMetric` to index.ts (was newly exported to remove duplication)
6. Dependencies check — ✅ Removed unused deps: `@cogitator-ai/types` and `nanoid` (neither imported anywhere in source)
7. Unit tests exist — ✅ All 15 source modules have test files
8. Unit tests pass — ✅ 273/273 tests pass across 15 files
9. E2E tests exist and pass — ✅ 3/3 E2E tests pass (simple QA eval, LLM-as-judge, A/B comparison)
10. Test coverage gaps — ✅ Added 5 regression tests: noRegression fails with no matching metrics, noRegression *Duration/*Latency isLowerBetter, assertion throws→passed:false, retry fallback duration>0
11. Package README — ✅ Accurate and comprehensive; added `isLLMMetric` to API reference table
12. Root README — ✅ evals in packages table, examples table, and quick-start section
13. Docs site — ✅ Full section at docs/evals/ with 7 MDX files covering all features
14. Examples — ✅ 3 examples: 01-basic-eval, 02-llm-judge, 03-ab-comparison — all use current API
15. CLAUDE.md — ✅ evals listed correctly in Architecture section

## Pending Steps

1. ~~Build~~
2. Lint
3. Remove comments
4. Full source review
5. Exports check
6. Dependencies check
7. Unit tests exist
8. Unit tests pass
9. E2E tests exist
10. Test coverage gaps
11. Package README
12. Root README
13. Docs site
14. Examples
15. CLAUDE.md

## Insights & Notes

- Package was in good shape overall: comprehensive test coverage (278 tests), 3 E2E tests, good docs
- Bugs were mostly in assertion correctness (regression.ts isLowerBetter inconsistency) and async hygiene (readFileSync in async function)
- Duplicate `isLLMMetric` between eval-builder.ts and eval-suite.ts — classic copy-paste drift
- Two unused deps (nanoid, @cogitator-ai/types) had probably never been used and slipped through initial implementation
- noRegression "passes when all metrics missing" was a silent correctness bug that could hide regressions entirely
