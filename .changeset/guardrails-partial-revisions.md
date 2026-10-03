---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/config': minor
---

Guardrails take partial configs and keep the revisions they produce.

- `CogitatorConfig.guardrails` and `security.promptInjection` are `Partial<…>`: fields left out take the defaults, as the runtime always merged them. The YAML schema accepts partial blocks too (`thresholds` may name some categories).
- Guardrails are on when configured, unless `enabled: false`, matching `DEFAULT_GUARDRAIL_CONFIG`. The run checks the merged config: a partial config such as `{ enabled: true }` filtered nothing before.
- When the output filter blocked an answer and the critique-revise loop produced a safe one, `filterOutput()` returned `allowed: true` with the revision, so the run kept the original harmful text and the violation was never logged. It now returns the block with `suggestedRevision`, the run answers with the revision, and the violation reaches the log and `onViolation`.
- `filterToolResults` is implemented: tool results pass the input filter before the model reads them (`ConstitutionalAI.filterToolResult()`).
