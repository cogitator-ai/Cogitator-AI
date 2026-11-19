---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

A fifth recipe, `plan`: two to four agents plan the same work and settle on one plan.

- Each planner writes a plan apart, as the report of its job. The bridge keeps the drafts as files only once all of them are in, so nobody plans from the plan of another. Each then reads the plans of the others and reports a critique, the first planner merges all of it into `plan.md` and writes to `decisions.md` what it did with every point, and the others sign the plan or object to it. The merger answers objections `rounds` times at most, 2 by default.
- The recipe ends when every checker signed, when the rounds ran out, when a round of answers left no fewer objections open, or when the merger gave no answer. What is still open is in the report and under a heading of its own at the end of the plan.
- The files of a run lie in `.cogitator/plans/job-<number>` under the folder the recipe was started in, ignored by git. `out` names where a copy of the plan goes, a path inside the repository at which nothing is yet. The report names what changed in the repository while the plan was written.
- `cogitator bridge plan --with claude --with codex "..."` starts it from a session, with `--rounds`, `--out` and the context flags. Agents start it with the tool `plan`.
- New exports of `@cogitator-ai/bridge/recipes`: `planRecipe`, `DEFAULT_PLAN_ROUNDS`, `verdictOf`.
