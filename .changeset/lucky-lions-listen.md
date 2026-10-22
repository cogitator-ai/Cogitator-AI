---
'@cogitator-ai/rag': minor
---

Add a `JSONLLoader` for `.jsonl` / `.ndjson` files: one document per line, blank lines skipped, a parse error naming the file and the 1-based line number, and the same `contentField` / `metadataFields` options as `JSONLoader`.
