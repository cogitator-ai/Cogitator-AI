---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

The bridge keeps what became of every job and says from it who a job should go to.

- A job has a `type`, one word such as `code`, `fix`, `review` or `docs`. The built-in recipes name the types of their steps.
- `results()` lists what became of the jobs that ended: who carried each out, whether its checks, a review or the taking of its work confirmed the result, what its reviews found, how long it took, how many letters, and how many times it needed the person. A job that ended with nobody checking it is `unknown` and counts neither for nor against anybody.
- A failure counts against an agent only when it was its own doing (`failure` on the record of a job: `reported`, `silent`, `timeout`). A session that could not be started or a caller that did not answer leaves the result `unknown`.
- A review counts on the job it reviews: `createJob({ reviewOf })`, which the `build` and `review` recipes set themselves. A review by the author of the work, or one the author ordered, counts for nothing.
- `suggest({ type })` rates the harnesses by the share of their checked jobs that held, with the Wilson interval of that share, and says when there are too few checked jobs to tell them apart.
- While a harness has finished fewer jobs than the scoreboard needs to compare, the one that has done the fewest is tried first, and the reason says so.
- A job handed to `auto` goes to the harness `suggest` names, and `createJob` says why in `routed`. `auto:new` asks for a fresh session of it. `auto` never takes a session the caller works for, and gives a review to another harness than the one that did the work when there is one.
- Tools: `suggest`, and `type` on `delegate`, `build` and `race`. Command line: `cogitator bridge suggest [type]`, `cogitator bridge results`, `--type` and `--review-of`.
- New limits: `scoreWindowMs` (60 days) and `scoreMinJobs` (5).
- The protocol of the dispatcher is version 3: a command line of this version asks for a dispatcher of this version, and says to restart an older one.
