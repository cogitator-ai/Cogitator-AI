# Audit: @cogitator-ai/ai-sdk

Started: 2026-02-25

## Status: Complete

## Completed Steps

1. **Build** — No issues
2. **Lint** — No issues
3. **Remove comments** — No changes needed
4. **Full source review** — 6 issues found, all fixed:
   - **BUG (provider.ts)**: `createCogitatorProvider` used unsafe `unknown` cast to access non-existent `config.agents` on `Cogitator`. Fixed: now accepts `CogitatorProviderConfig` with explicit agents param.
   - **BUG (tools.ts)**: `return undefined as TResult` silently returned undefined. Fixed: now throws.
   - **TYPE (model-wrapper.ts)**: `provider: LLMProvider = 'openai'` hardcoded. Fixed: derives from model.
   - **TYPE (model-wrapper.ts)**: `Partial<ToolCall>[]` used where full `ToolCall` always constructed. Fixed.
   - **TYPE (provider.ts)**: Unnecessary spread + readonly incompatibility. Fixed.
   - **TYPE (types.ts)**: `Tool` imported from `@cogitator-ai/core` instead of `@cogitator-ai/types`. Fixed.
5. **Exports check** — All exports match public API. `AISDKModelWrapperOptions` exported but unused internally (public API, kept).
6. **Dependencies check** — Removed unused `@ai-sdk/provider-utils` from dependencies.
7. **Unit tests exist** — Created from scratch: 3 test files, 45 tests covering all modules.
8. **Unit tests pass** — 45/45 passing
9. **E2E tests exist** — Existing e2e tests at `packages/e2e/src/__tests__/ai-sdk/tool-adapter.e2e.ts`. Updated test for `fromAISDKTool` behavior change (throws instead of returning undefined). 11/11 passing.
10. **Test coverage gaps** — Added: error path in doStream, tool-call stream handling, mapFinishReason edge cases (length/error/unknown), no-clone-without-overrides.
11. **Package README** — Updated `createCogitatorProvider` API docs for new signature.
12. **Root README** — Already present in packages table and examples table.
13. **Docs site** — Updated `packages/dashboard/content/docs/integrations/ai-sdk.mdx` for new `createCogitatorProvider` API.
14. **Examples** — `examples/integrations/07-ai-sdk-adapter.ts` uses `cogitatorModel` directly, no update needed.
15. **CLAUDE.md** — ai-sdk listed in Architecture section on line 124.

## Summary

- **Total issues found**: 8 (6 code bugs/type issues + 1 unused dep + 1 missing test infrastructure)
- **All fixed**: Yes
- **Breaking changes**: `createCogitatorProvider` now requires 2nd `config` arg with `agents` field
- **New files**: vitest.config.ts, 3 test files (tools.test.ts, provider.test.ts, model-wrapper.test.ts)
- **Build**: Pass | **Tests**: 45 unit + 11 e2e | **Lint**: Clean
