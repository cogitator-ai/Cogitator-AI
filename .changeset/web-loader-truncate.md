---
'@cogitator-ai/rag': minor
---

`WebLoader` can load the first part of a page over `maxResponseBytes`: with `onTooLarge: 'truncate'` it stops the download at the limit and loads what came, marking the document `truncated: true` in its metadata. Many news pages carry megabytes of scripts after their text, which failed the whole load before. `onTooLarge: 'fail'` stays the default.
