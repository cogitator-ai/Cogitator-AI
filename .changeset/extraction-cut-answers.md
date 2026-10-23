---
'@cogitator-ai/memory': minor
---

Fix extraction and hierarchical compaction of dense windows, which failed with "The extraction model did not answer with memory items after 3 tries" and "The summarizer did not answer with the atoms of a chapter after 3 tries".

A window of a long list of facts can hold more items than one extraction answer has room for (8000 tokens), so the answer was cut inside its JSON array, and the extractor read no item from it and asked again the same way three times. `MemoryExtractor` now keeps the items a cut answer finished and asks the model to go on after the last one, up to `EXTRACTION_CONTINUATIONS` (4) times (`extractionContinuationPrompt`), so the window is read whole. `parseExtraction` finds the array past text and brackets around it, such as a message number the model mentions (`[3]`), keeps the finished items of a cut array and leaves out an element that is not JSON instead of the whole answer. A continuation that brings no array ends the window with the items read so far.

Compaction chapters had the same faults: a chapter call asked for no token limit of its own, so it got the backend's default (4096 on Anthropic), and a dense chapter of 4000 tokens can need more. A chapter call now asks for up to 8000 tokens, like extraction, and `CompactionService.chapterAtoms` keeps the atoms a cut answer finished and asks the summarizer to go on after the last one, up to 4 times, the array of atoms is found past text and brackets around it, and an element that is not an atom (such as one of another kind) is left out instead of failing the whole answer. `parseBrief` reads its array the same way and keeps the cards of a cut answer, without a second call, since the brief runs before the turn within a time limit. Consolidation still takes only a whole answer on purpose: its decisions are made as a set.

A continuation leaves out only what repeats an earlier answer exactly (the same words and quotes), so a value or a status said again from a later message stays the latest. The array search reads at most four times the length of the answer, however many brackets it holds, and an empty array before the real one no longer hides it.
