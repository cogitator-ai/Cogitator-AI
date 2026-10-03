---
'@cogitator-ai/workflows': patch
---

`humanNode`, `approvalNode`, `choiceNode`, `inputNode`, `ratingNode`, `chainNode` and `managementChain` return `NamedHumanNodeConfig` — the config with its `name` known to be set — so `config.name` can be passed where a string is required.
