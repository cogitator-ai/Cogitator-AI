---
'@cogitator-ai/channels': patch
---

`RuntimeBuilder` takes the config as written (`AssistantConfigInput`) and applies the schema itself, so a config built in code no longer has to spell out fields that have defaults (`memory.autoExtract`, `memory.knowledgeGraph`, channel policies); an invalid config throws when the builder is created.
