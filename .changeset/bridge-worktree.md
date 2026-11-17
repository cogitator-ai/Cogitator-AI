---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

A job can be done in a git worktree of its own, the bridge checks its result, and its work comes back when it is taken.

- **A worktree for a job.** `createJob({ worktree: true })`, `delegate` with `worktree` and `cogitator bridge delegate --worktree` give a job a git worktree under `.cogitator/worktrees/` of the project, on a branch of its own, off the commit the caller's checkout is at, and a session started for it there. For jobs that change files while others do. No more than `limits.worktreesPerProject` (2) such jobs of a project are in progress at once.
- **What a job changed.** When a job in a worktree is reported on, the bridge reads what it changed, committed or not, and the report says so. `diff({ job })`, the tool `diff` and `cogitator bridge diff <job>` show the files and the patch.
- **Checks the bridge runs.** The `checks` of a job are run when it is reported on, where it was done, and the report is held back until they end and handed over with the verdict. Only commands the rules of the agent that handed the job over allow without asking are run, the rest are left out and the result is then not verified. `delegate` takes `checks` too. `job.verification` keeps each check's result.
- **Taking the work.** `accept({ job })`, the tool `accept` and `cogitator bridge accept <job>` bring the work of a finished job into the caller's checkout as one staged change that is not committed. Files that would conflict are named and nothing is touched. `asBranch` (`--as-branch`) leaves the work as a branch. `reject` drops it. A worktree nobody came for is removed after `limits.worktreeKeepMs` (7 days), its work kept under `refs/cogitator/discarded/`.
- **Claude Code sessions the bridge starts work in place.** They get `worktree.bgIsolation: "none"`: before, such a session moved into a worktree of Claude Code's own before its first edit, made from the default branch of `origin`, where nobody looked for its changes. Ask for a worktree of the bridge to keep a job apart.
- `@cogitator-ai/bridge/testing`: the stand-in of `claude` moves a background session into a worktree of its own before its first edit unless its settings say it works in place, the way Claude Code does.

A letter has one more state, `held`, before `queued`: a report whose checks still run. `BridgeJobRecord.worktree` is an object now (`path`, `branch`, `base`, `end`), it was a string nothing ever set. The socket has three new methods, `jobs/diff`, `jobs/accept` and `jobs/reject`: restart a dispatcher that runs.
