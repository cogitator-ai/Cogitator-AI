---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/config': minor
---

Personal data stays away from the model provider. `security.pii` replaces emails, phone numbers, card numbers (Luhn-checked), IBANs (mod-97), SSNs, IP addresses, API keys and your own patterns with placeholders such as `[EMAIL_1]` in every LLM request. In `mask` mode the answer, its stream and tool call arguments get the real values back, so tools still act on the real address; `redact` keeps the placeholders everywhere, and `block` rejects such input with `PII_DETECTED`. `onDetect` receives counts per kind for audit logs, never the values. `PiiMasker`, `PiiVault` and `withPiiMasking` are exported for use outside a run, and YAML config accepts custom patterns as strings.
