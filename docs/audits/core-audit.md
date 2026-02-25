# Audit: @cogitator-ai/core

Started: 2026-02-24

## Status

**Complete**
Last updated: 2026-02-24

## Completed Steps

### 1. Build — PASS

No issues. `tsc` compiles cleanly.

### 2. Lint — PASS

No lint errors in `packages/core/`.

### 3. Remove comments — PASS

No comments found to remove. 0 files modified.

### 4. Full source review — 30 bugs fixed

**7 parallel review agents scanned 90+ source files. Findings:**

#### BUGS FIXED — Phase 1 (20):

1. `runtime.ts:374` — Empty `toolCalls[]` causes infinite loop → added `.length > 0` check
2. `message-builder.ts:183-185` — `+=` on `ContentPart[]` corrupts multimodal messages → typeof guard
3. `message-builder.ts:193` — Same `+=` issue in `addContextToMessages` → typeof guard
4. `openai.ts:71` — Crash if `response.choices` is empty → added guard + `llmInvalidResponse`
5. `azure.ts:81` — Same empty choices crash → added guard + `llmInvalidResponse`
6. `bedrock.ts:236-239,288-290` — `temperature: 0` and `maxTokens: 0` silently ignored → `!== undefined`
7. `ollama.ts:181` — Unguarded `JSON.parse` in streaming → try/catch + continue
8. `google.ts:136,169` — API key leaked in URL query string → moved to `x-goog-api-key` header
9. `logger.ts:142` — Invalid `LOG_LEVEL` env var silences all logging → validated against set + fallback
10. `tool-executor.ts:57` — Sandbox path uses raw args instead of Zod-parsed data → pass `parseResult.data`
11. `web-search.ts:152` — `data.organic` may be undefined → `(data.organic ?? [])`
12. `github.ts:153` — `state: 'all'` silently treated as `state: 'open'` → removed `!== 'all'` filter
13. `github.ts:339-341` — `list_commits` malformed URL → rebuild queryString with `sha` param
14. `calculator.ts:151,163` — Out-of-bounds array access → added bounds checks
15. `fallback.ts:110` — Crash when `providers` array is empty → added validation
16. `sql-query.ts:100` — SQLite always opened readonly → pass `readOnly` param to function
17. `sql-query.ts:136` — Overly broad SQLite detection → removed `.includes('.db')`
18. `constitutional/prompts.ts:59` — `m.content.slice()` on ContentPart[] → typeof guard
19. `summarize.ts:113` — `backend: any` → `LLMBackend`
20. `sliding-window.ts:101` — `backend: any` → `LLMBackend`

#### BUGS FIXED — Phase 2 (9, previously "noted"):

21. `rollback-manager.ts:12-16,80-131` — 5x `null as unknown as InstructionVersion` unsafe casts → changed `RollbackResult` interface to allow `null` for `previousVersion`/`newVersion`
22. `metrics.ts:353` — `createExactMatchMetric` `fieldPath` parameter was dead code → implemented JSON field path drilling with dot notation
23. `auto-optimizer.ts:305` — `getActiveTest()` returned null for just-completed test → added `getTest(testId)` to `ABTestingFramework`, use it instead
24. `causal-reasoner.ts:347` — Wrong agentId extraction from hypothesis ID (`hypothesis-{n}-{ts}`.split('-')[0] = "hypothesis") → use `context.originalTrace.agentId`, added optional `agentId` parameter
25. `langfuse.ts:194-211` — `onLLMResponse` was a no-op, `onToolCall` didn't store span → added `activeGenerations` map, store generation in `onLLMCall`, finalize in `onLLMResponse` with `generation.end()`; store tool spans with `tool:{callId}` key matching `onToolResult` lookup
26. `thought-tree.ts:432-443` — Unsafe double casts `(this.cogitator as unknown as {...})` → added public `getLLMBackend()` method and `reflectionEngine` getter to `Cogitator` class
27. `google.ts:413-418` — `image_url` with data URIs mapped to `fileData` instead of `inlineData` → extract base64 from data URIs, use `inlineData`
28. `google.ts:352,370` — Dead `pendingToolResults` map and condition referencing it → removed
29. `patterns.ts:258,277` — `indexOf` finds first occurrence for duplicate matches → switched to `matchAll` with proper index tracking

30. `message-builder.ts:24-59` — Dead audio transcription code (primitive raw-fetch duplicate of `@cogitator-ai/voice` OpenAISTT) → removed along with unused `AudioInput` import and `audioInputToBuffer` import

#### SECURITY FIXES (6):

31. `sql-query.ts:38-42` — `isReadOnlyQuery` bypassable via `;` injection (`SELECT 1; DROP TABLE x`) → added multi-statement detection, dangerous keyword scanning after stripping string literals
32. `regex.ts:24-35` — ReDoS vulnerability (user-supplied regex with catastrophic backtracking) → added 5s timeout with `execRegexWithTimeout()`, 1M char input limit, applied to both `regexMatch` and `regexReplace`
33. `llm-classifier.ts:58` — Second-order prompt injection (user input inserted raw into analysis prompt, `"""` escapes the block) → escape `"""` sequences in input before substitution
34. `llm-classifier.ts:71-73` — Fail-open on LLM failure (returns `[]` = "safe" when LLM is down) → fail-closed: return synthetic threat with `type: 'custom', pattern: 'llm_analysis_failed'`
35. `prompt-injection-detector.ts:100-107` — Allowlist substring bypass (`"ignore all, weather query"` passes if `"weather query"` is allowlisted) → changed from `includes()` to exact match via `Set.has()` on full normalized input
36. `postgres-trace-store.ts:64` — SQL injection via `${this.schema}` interpolation → validate schema name against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` in constructor, reject invalid names

### 5. Exports check — PASS

All public API items properly exported from `index.ts`. No internal leaks.

### 6. Dependencies check — FIXED

Added `better-sqlite3` and `langfuse` as optional peer dependencies (dynamically imported).

### 7. Unit tests exist — PASS

50+ test files covering all major modules. Excellent coverage.

### 8. Unit tests pass — PASS

1040 passed, 0 failed, 24 skipped (integration tests requiring API keys).

### 9. E2E tests exist and pass — PASS

6 E2E test files in `packages/e2e/src/__tests__/core/`, 17 tests total. All passed with local Ollama (`TEST_OLLAMA=true`).

### 10. Test coverage gaps — FIXED

**New test files written (5):**

- `rollback-manager.test.ts` — 16 tests: deploy, rollback, metrics recording, version comparison, findBestVersion, pruning
- `ab-testing.test.ts` — 16 tests: full lifecycle, variant selection, result recording, Welch's t-test statistical analysis, auto-completion
- `langfuse.test.ts` — 15 tests: trace/span/generation lifecycle, LLM call/response with usage, tool call/result span tracking, flush/shutdown
- `postgres-trace-store.test.ts` — 7 tests: schema name SQL injection prevention, valid/invalid schema patterns
- Additional tests in existing files:
  - `learning.test.ts` — 5 new fieldPath drilling tests for `createExactMatchMetric`
  - `sql-query.test.ts` — 7 new SQL injection prevention tests (multi-statement, embedded keywords, string literal handling)
  - `regex.test.ts` — 3 new security tests (max text length boundary)
  - `prompt-injection.test.ts` — 2 new allowlist exact-match tests (substring bypass prevention)

**Bug found by tests:** `metrics.ts` `createExactMatchMetric` fieldPath drilling used wrong variable for nested path traversal — fixed.

Total: 1040 tests passed (was 962), 0 failed.

### 11. Package README — PASS

1,439 lines. All major features documented with examples.

### 12. Root README — PASS

Core listed in packages table with 12 examples.

### 13. Docs site — PASS

6 MDX pages in `packages/dashboard/content/docs/core/`.

### 14. Examples — PASS

12 examples in `examples/core/` covering all major features.

### 15. CLAUDE.md — PASS

Listed in Architecture section, Key Classes, and LLM Backends.

## Summary

| Metric                | Value                               |
| --------------------- | ----------------------------------- |
| Total issues found    | 37                                  |
| Bugs fixed            | 31 (including 1 found by new tests) |
| Security issues fixed | 6                                   |
| Files modified        | 30                                  |
| Build                 | PASS                                |
| Lint                  | PASS                                |
| Unit tests            | 1040 passed (+78 new tests)         |
| E2E tests             | 6 files (Ollama-dependent)          |
| Documentation         | Complete                            |

## Insights & Notes

- Core is the largest package in the monorepo (~90+ source files)
- Most critical bugs were in runtime loop prevention, multimodal content handling, and LLM backend edge cases
- Google backend had API key in URL — moved to header for security
- Bedrock backend had falsy check bug (temperature=0 ignored)
- ~~Azure backend is near-complete duplicate of OpenAI backend~~ — **FIXED**: created `OpenAICompatibleBackend` abstract base class. OpenAI: 373→20 lines, Azure: 383→31 lines (93% reduction in concrete classes).
- ~~Security module has architectural issues (fail-open defaults)~~ — **FIXED**: added `failMode: 'secure' | 'open'` to `PromptInjectionConfig` (default: `secure`). Invalid regex now reported as threat. LLM classifier fails closed on unparseable response. +7 tests.
- Several module-level counters in causal/ are not per-instance — verified as cosmetic, counters are already per-instance in current code.
- ~~LLM backends have inconsistent error handling patterns across providers~~ — **FIXED**: created shared `wrapSDKError()` in errors.ts. OpenAI/Azure/Anthropic now delegate to unified error handler with consistent status code mapping, retry-after parsing, and context length/content filter detection.
- Langfuse integration was entirely non-functional (generations never finalized, tool spans never stored) — now properly wired
- Cogitator class lacked public API for LLM backend access — added `getLLMBackend()` and `reflectionEngine` getter
- ABTestingFramework lacked `getTest(id)` for retrieving tests by ID regardless of status — added
