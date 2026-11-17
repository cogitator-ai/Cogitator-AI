---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

Recipes: the bridge carries a job out by fixed steps, handing jobs of its own to the agents, and reports once at the end. No model decides what comes next.

- **The conductor.** `recipeAdapter()` of the new entry `@cogitator-ai/bridge/recipes` adds an agent without a model under the harness word `recipe`. `createJob({ to: 'recipe', recipe: { name, input } })` starts a recipe as an ordinary job: the jobs it hands out are part of it, so its budget, its deadline and its cancel hold for them, and whoever started it may `diff` and `accept` their work. The conductor has no rules of its own: checks and permission requests of its steps are judged by the rules of whoever started the recipe, and a question of a worker is passed on to them.
- **`build`: do, check, review, fix, check.** An agent does the job in a worktree of its own, the bridge runs the checks, an agent of another harness reviews the work, and the author fixes what was found until nothing at or above the threshold is open or the rounds run out. **`review`** runs the same rounds for a job that is done. As tools (`build`, `review`), as commands (`cogitator bridge build`, `review`, `recipe`) and through `createJob`.
- **Findings.** A report takes `findings`, each with a severity (`blocker`, `major`, `minor`, `nit`), a summary and where it is. An agent without the tools writes lines such as `[major] src/a.ts:12 - what is wrong` or `[none]`, which `parseFindings` reads. They are kept on the job and shown under its report.
- **Durable.** Every run is a workflow of `@cogitator-ai/workflows`, now an optional peer dependency, with a checkpoint after each step, and a step finds the job it handed over before by the id of its first letter. With `FileCheckpointStore` a dispatcher that is restarted picks every open recipe up where it was. `cogitator bridge serve` and the daemon keep the checkpoints in `recipes` in the folder of the bridge.
- **Your own recipes** with `defineRecipe({ name, input, workflow })` and `recipeAdapter({ recipes })`.
- `wakes(agent)` says whether a session takes a letter by itself right now, and an adapter may say so for its sessions with `wakesFor`. A recipe hands a later step to a fresh session of the same harness when the agent that did the earlier one would not wake, such as a Codex thread that is open nowhere while no local daemon runs.

Restart a dispatcher that runs to get the conductor.
