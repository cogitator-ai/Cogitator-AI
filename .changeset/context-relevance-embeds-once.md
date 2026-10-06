---
'@cogitator-ai/memory': patch
---

The `relevant` and `hybrid` context strategies embed each history entry once instead of on every turn. Vectors are cached per builder by entry id, and only the newest 200 entries are scored, so a long thread no longer sends its whole history to the embedding API with each message.
