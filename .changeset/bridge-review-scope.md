---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': patch
---

The review of `build` and `review` judges the work against its job, and stops when it stops getting closer.

- A finding can be marked as noticed beside the job: `beside: true` in the findings of a report, `[beside major] src/cache.ts:9 - ...` in a line. It is for a fault that was there before the job in code it had no need to change, or a case the job does not ask for. Such a finding is not sent back to the author, does not hold the work up whatever it weighs, and does not count against the author on the scoreboard. The reviewer is told to judge the work against the job and to mark the rest.
- The report of the recipe lists what the reviews noticed beside the job apart from how the review ended, so work that passed with something noticed next to it no longer reads like work that did not pass.
- A round of fixes that leaves no fewer findings open than there were before it ends the review while rounds are left, and the report says so, instead of sending the author back once more.
- Work of the type `fix` is sent back once at most by default, other work twice as before. `rounds` in the input still decides when it is given.
- New exports: `ofTheWork`, `holdsUp`, `severitiesCount`, `FIX_REVIEW_ROUNDS`. `findingsCount` counts the findings of the work by severity and those beside the job as one number.
