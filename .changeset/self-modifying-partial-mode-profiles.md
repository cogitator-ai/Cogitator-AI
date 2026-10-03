---
'@cogitator-ai/self-modifying': minor
---

`metaReasoning.modeProfiles` accepts profiles for only some modes and only some fields (`MetaReasoningOverrides`, `ModeProfileOverrides`); each is merged over the default profile of its mode, so a partial profile no longer drops the mode's other fields. `mergeModeProfiles` is exported.
