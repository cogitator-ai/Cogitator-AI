---
'@cogitator-ai/swarms': minor
'@cogitator-ai/types': minor
---

Debate turns name their speaker. The transcript that debaters and the moderator read labelled every turn by role, so with all debaters advocates it read "[advocate]: ..." throughout and nobody could tell who said what. Turns are now labelled with the speaker's name and its role when it has one. A new `synthesisPrompt` on `DebateConfig` replaces the moderator's fixed "summarise both sides" task, with `{topic}` and `{transcript}` filled in, for callers who want their own decision step. The `maxTokensPerTurn` docs now say that a reasoning model spends its reasoning from that budget, which left turns empty or cut off at a few hundred tokens.
