---
'@cogitator-ai/rag': minor
---

`WebLoader` can load the first part of a page over `maxResponseBytes`: with `onTooLarge: 'truncate'` it stops the download at the limit and loads what came, marking the document `truncated: true` in its metadata. A page over the limit no longer fails the whole load. The first part holds the text only when the page puts it there: many news pages carry megabytes of scripts before their article, so keep `maxResponseBytes` above the pages you load and use `truncate` as a safety net, not to lower the limit. `onTooLarge: 'fail'` stays the default.
