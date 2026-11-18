---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

Two more recipes of the bridge: `race` and `debate`.

- **`race`.** The same job to two or more agents at the same time, each in a git worktree of its own. The bridge runs the checks on every attempt and the report lays them side by side: which finished, what the checks showed, how much each changed. With a `judge` another agent compares them and names the one it would take. Whoever started the race takes one with `accept` and drops the others with `reject`.
- **`debate`.** A question to several agents by the rules of the `debate` strategy of `@cogitator-ai/swarms`, with sessions of any harness as debaters: each answers alone first, then they answer each other round by round and end every turn with `STANCE: agree` or `STANCE: disagree`. It ends when all agree or the rounds run out, and a `moderator` sums it up.
- As tools (`race`, `debate`), as commands (`cogitator bridge race --to codex --to claude`, `cogitator bridge debate --with codex=advocate --with claude=critic`) and through `createJob({ to: 'recipe', recipe })`.
- A step of a recipe waits its turn when the project already has as many worktrees in progress as the bridge keeps, instead of failing the recipe.
