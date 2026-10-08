---
'create-cogitator-app': patch
---

`sendTelemetry` sends nothing for a payload that is not exactly an event: the documented fields and no other, each a short value of letters, digits and `._,-`. It is exported, so a JavaScript caller could hand it anything, and analysis sandboxes that call every export with test values sent them to the project's analytics.
