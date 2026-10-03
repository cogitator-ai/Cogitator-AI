---
'@cogitator-ai/core': patch
---

Context management turns on when `context` is configured. The runtime created the context manager only with `enabled: true`, although `enabled` defaults to true and the documented strategy examples leave it out, so those configs silently never compressed anything. Pass `enabled: false` to keep a config switched off.
