---
'@cogitator-ai/browser': patch
---

`browser_get_api_calls` with `clear: true` wiped every recorded API call, including the ones its `urlPattern`/`method` filters left out. It now removes only the calls it returned, so filtered reads no longer lose unrelated history.
