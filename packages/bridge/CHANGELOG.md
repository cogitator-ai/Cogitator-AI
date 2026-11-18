# @cogitator-ai/bridge

## 0.13.1

### Patch Changes

- [#391](https://github.com/cogitator-ai/Cogitator-AI/pull/391) [`7794385`](https://github.com/cogitator-ai/Cogitator-AI/commit/7794385947fcf6dad72c03d4c97b3dcf43e225a0) - The README says what the bridge does with your subscriptions and what it does not: it drives the `claude` and `codex` commands you signed in, keeps no login and no token, and is no way around a limit. It names what the terms of Anthropic and OpenAI forbid (letting others work on your plan, sharing a login, running it as a service) and what they leave open, and the section on offering agents to the outside says the same of that door.

## 0.13.0

### Minor Changes

- [#388](https://github.com/cogitator-ai/Cogitator-AI/pull/388) [`853ec7b`](https://github.com/cogitator-ai/Cogitator-AI/commit/853ec7bb4539be84b923f25f05b8e02fcff44da4) - The agents of a bridge can be offered to the outside: as an A2A service and as the tools of an MCP server.

  - `bridgeAgents()` from `@cogitator-ai/bridge/outward` returns the agents of the bridge with what runs them, in the shape `A2AServer` and `serveAgents` take. A message or a tool call becomes a job of the bridge, and the report of the agent is the answer.
  - A question of the agent pauses the run like a question of a tool: an A2A task waits in `input-required` and the next message answers it. A tool call answers with the question and the thread to answer it on.
  - A caller that gives up or moves on takes its job back, and so does a door that closes. Leave for a call is asked through the bridge, from the person at the machine, never from the caller.
  - Each door is a session of its own in the book of the bridge, so two of them never read each other's mail.
  - `waitForMail()` results have `release()`, which gives the letters up for the next waiter instead of confirming them.
  - `cogitator bridge offer [agent...]` serves the agents as MCP tools on stdio, for the configuration of any MCP client.

## 0.12.2

### Patch Changes

- [#387](https://github.com/cogitator-ai/Cogitator-AI/pull/387) [`9e268a3`](https://github.com/cogitator-ai/Cogitator-AI/commit/9e268a3731f316b4ecc04748b647fbcc2579bbfc) - Three things a run with agents on other models showed.

  - A job whose checks pass in a worktree it changed nothing in no longer counts as confirmed on the scoreboard: the checks passed before it began. An agent that answers "Done" without doing anything is now `unknown` until a review says otherwise, not `good`.
  - A permission request of a hosted runtime agent shows the call alone. It used to start with the description of the tool, a manual of several lines that says nothing of the call.
  - `suggest` writes "1 call" and "1 letter".

## 0.12.1

### Patch Changes

- [#386](https://github.com/cogitator-ai/Cogitator-AI/pull/386) [`e410fc9`](https://github.com/cogitator-ai/Cogitator-AI/commit/e410fc96354a6b2a7854725f2d8d153df1f1a3f9) - `cogitator bridge serve` hosts agents of the Cogitator runtime on any model as members of the bridge.

  - `serve --agent <name>=<model>` (repeatable, or `COGITATOR_BRIDGE_AGENTS`) runs a coding agent on that model under a word of its own: `--agent qwen=ollama/qwen3-coder:30b`. Other agents hand it jobs like any other: `delegate qwen`, `build qwen --by claude`, a seat in a race or a debate.
  - Every job gets a session of its own, which works in the folder of the job, changes files there without asking and asks through the bridge for every other call.
  - The providers and their keys come from the config file `-c, --config` names, the one of the folder `serve` runs in, or the environment. `cogitator daemon start --bridge` reads the same variable.
  - A turn that fails on the rate limit or the quota of the provider hands the job to another agent, and with `--fallback <name>` such an agent takes a job only when the others cannot.
  - `@cogitator-ai/bridge` exports `HarnessNameSchema`.

## 0.12.0

### Minor Changes

- [#385](https://github.com/cogitator-ai/Cogitator-AI/pull/385) [`6ece2f8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6ece2f8df8fd5e99cfbe6127b7c6468804a1bda9) - The bridge knows when an agent ran into the limit of its subscription or its key, and hands its jobs to another agent.

  - A limit is read from what the harness itself says: the failure of a `codex exec` turn, a `StopFailure` hook of Claude Code for `rate_limit` and `billing_error` (installed by `cogitator bridge install` and carried by every session the bridge starts), and the rate limit and quota errors of a hosted agent's provider. `limitOf`, `limitResetOf` and `limitOfError` read the words and the time a limit is over.
  - `limited(caller, { until, detail })` notes the harness as out of its limit until the time it named, or for `limits.limitRetryMs` (30 minutes) when it named none. `status().limited` lists them.
  - No job goes to such a harness: `auto` passes it over, and a job addressed to it is refused with the new error code `limit_reached`.
  - The jobs the session carried out go to a fresh session of another harness, in the same folder, with the job's number and letters kept, its time given anew and `redirects` on its record. A job nobody else can take fails with `failure: 'other'`.
  - A limit ends when its time is over, when an agent of that harness finishes a job, or with `unlimit(agent)`. Of two limits of a harness the longer one stays.
  - `routing.fallback` names harnesses of last resort, which take a job only when no other can.
  - A step of a recipe that would go back to an agent whose harness is out of its limit goes to a fresh session of whoever takes jobs.
  - Command line: `cogitator bridge limits [--clear <agent>]`, `cogitator bridge limited --hook claude-code`, `cogitator bridge serve --fallback <agent>` and `COGITATOR_BRIDGE_FALLBACK`. `status` and `log` show limits and jobs that were handed on.
  - The stand-in of `claude` in `@cogitator-ai/bridge/testing` ends its turns on the API error `FAKE_CLAUDE_TURN_ERROR` names and runs the `StopFailure` hooks for it.

## 0.11.0

### Minor Changes

- [#384](https://github.com/cogitator-ai/Cogitator-AI/pull/384) [`c78f590`](https://github.com/cogitator-ai/Cogitator-AI/commit/c78f590a8423d9e0614727a6ae38ffc08cfe888b) - The bridge keeps what became of every job and says from it who a job should go to.

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

### Patch Changes

- Updated dependencies [[`4fbadb8`](https://github.com/cogitator-ai/Cogitator-AI/commit/4fbadb8620844d221d509201a398d76f58797aa9)]:
  - @cogitator-ai/evals@0.15.0

## 0.10.2

### Patch Changes

- [#382](https://github.com/cogitator-ai/Cogitator-AI/pull/382) [`ccf97c4`](https://github.com/cogitator-ai/Cogitator-AI/commit/ccf97c447e9735db125679a68dae8727e2dd2fbc) - The stand-ins of `claude` and `codex` in `@cogitator-ai/bridge/testing` wait for their hooks and commands before a session that is stopped is gone.

  - A session that was stopped asked its hooks to end and left at once. A hook that still wrote to its pipes after that, if only the word of its shell on a child the signal killed, died of SIGPIPE before its own handler of the signal had run. On a loaded machine a test saw the hook gone and its cleanup not done.
  - A session now stays until its hooks and commands have ended and keeps reading their output until then. One that does not end in three seconds is killed, where it used to be left running.
  - While it waits, the session takes no new message and goes no further with the turn it was in, so nothing is changed or recorded after the stop.

## 0.10.1

### Patch Changes

- [#381](https://github.com/cogitator-ai/Cogitator-AI/pull/381) [`31e4913`](https://github.com/cogitator-ai/Cogitator-AI/commit/31e4913e26e63ae621edd91cdc87f1eaec0540c6) - A session that ends its turn without reporting on its job is reminded to report.

  Live runs of the recipes showed a Claude Code session answer in its own window and stop, with its job left in progress until the deadline, four hours by default, and the recipe waiting with it. A session that has waited for mail for `limits.reportReminderMs` (one minute) with a job it carries out and has not reported on now gets a letter that says so, which wakes it. A session that does not react within the reply timeout of the job fails the job with that reason. One that reacts with anything but a report is reminded again no sooner than that timeout. A session is left alone while its harness lists it in the middle of a turn, while it waits for an answer, for a job it handed over or for the person, and while its checks run.

## 0.10.0

### Minor Changes

- [#380](https://github.com/cogitator-ai/Cogitator-AI/pull/380) [`3ece7b4`](https://github.com/cogitator-ai/Cogitator-AI/commit/3ece7b4f1aed7618d39cd8ca6a960be5d23def5e) - Two more recipes of the bridge: `race` and `debate`.

  - **`race`.** The same job to two or more agents at the same time, each in a git worktree of its own. The bridge runs the checks on every attempt and the report lays them side by side: which finished, what the checks showed, how much each changed. With a `judge` another agent compares them and names the one it would take. Whoever started the race takes one with `accept` and drops the others with `reject`.
  - **`debate`.** A question to several agents by the rules of the `debate` strategy of `@cogitator-ai/swarms`, with sessions of any harness as debaters: each answers alone first, then they answer each other round by round and end every turn with `STANCE: agree` or `STANCE: disagree`. It ends when all agree or the rounds run out, and a `moderator` sums it up.
  - As tools (`race`, `debate`), as commands (`cogitator bridge race --to codex --to claude`, `cogitator bridge debate --with codex=advocate --with claude=critic`) and through `createJob({ to: 'recipe', recipe })`.
  - A step of a recipe waits its turn when the project already has as many worktrees in progress as the bridge keeps, instead of failing the recipe.

### Patch Changes

- Updated dependencies [[`2535be8`](https://github.com/cogitator-ai/Cogitator-AI/commit/2535be865cf32c6b86be122c6145aa93781b7043)]:
  - @cogitator-ai/workflows@0.15.8
  - @cogitator-ai/types@0.89.1
  - @cogitator-ai/a2a@0.12.1
  - @cogitator-ai/core@0.79.1
  - @cogitator-ai/memory@0.29.8
  - @cogitator-ai/server-shared@0.17.1

## 0.9.0

### Minor Changes

- [#378](https://github.com/cogitator-ai/Cogitator-AI/pull/378) [`c9f176a`](https://github.com/cogitator-ai/Cogitator-AI/commit/c9f176a776baa3ac1ad4cb635da8580aedbb2262) - Recipes: the bridge carries a job out by fixed steps, handing jobs of its own to the agents, and reports once at the end. No model decides what comes next.

  - **The conductor.** `recipeAdapter()` of the new entry `@cogitator-ai/bridge/recipes` adds an agent without a model under the harness word `recipe`. `createJob({ to: 'recipe', recipe: { name, input } })` starts a recipe as an ordinary job: the jobs it hands out are part of it, so its budget, its deadline and its cancel hold for them, and whoever started it may `diff` and `accept` their work. The conductor has no rules of its own: checks and permission requests of its steps are judged by the rules of whoever started the recipe, and a question of a worker is passed on to them.
  - **`build`: do, check, review, fix, check.** An agent does the job in a worktree of its own, the bridge runs the checks, an agent of another harness reviews the work, and the author fixes what was found until nothing at or above the threshold is open or the rounds run out. **`review`** runs the same rounds for a job that is done. As tools (`build`, `review`), as commands (`cogitator bridge build`, `review`, `recipe`) and through `createJob`.
  - **Findings.** A report takes `findings`, each with a severity (`blocker`, `major`, `minor`, `nit`), a summary and where it is. An agent without the tools writes lines such as `[major] src/a.ts:12 - what is wrong` or `[none]`, which `parseFindings` reads. They are kept on the job and shown under its report.
  - **Durable.** Every run is a workflow of `@cogitator-ai/workflows`, now an optional peer dependency, with a checkpoint after each step, and a step finds the job it handed over before by the id of its first letter. With `FileCheckpointStore` a dispatcher that is restarted picks every open recipe up where it was. `cogitator bridge serve` and the daemon keep the checkpoints in `recipes` in the folder of the bridge.
  - **Your own recipes** with `defineRecipe({ name, input, workflow })` and `recipeAdapter({ recipes })`.
  - `wakes(agent)` says whether a session takes a letter by itself right now, and an adapter may say so for its sessions with `wakesFor`. A recipe hands a later step to a fresh session of the same harness when the agent that did the earlier one would not wake, such as a Codex thread that is open nowhere while no local daemon runs.

  Restart a dispatcher that runs to get the conductor.

## 0.8.0

### Minor Changes

- [#377](https://github.com/cogitator-ai/Cogitator-AI/pull/377) [`4de9815`](https://github.com/cogitator-ai/Cogitator-AI/commit/4de98156480821f0c483d04912029e9248a0161d) - A job is handed over with what its caller knows, and the agents of a project share a board of notes.

  - **The handover.** `createJob({ context })`, the `context` of the `delegate` tool and the flags `--done`, `--constraint`, `--decision` and `--file` of `cogitator bridge delegate` name what done looks like, the constraints, the decisions and the files to start from. The bridge puts them under the job in one block and adds the named lines of those files and the notes of the board that fit, within `contextTokens` (6000 by default, `limits.contextTokens`). No model is called.
  - **The board of facts.** `remember`, `recall` and `forget`, as calls of the dispatcher and the client, as tools and as commands of `cogitator bridge`. A note is a fact or a lesson of a project, kept with who said it, on which job and when, for the whole project or for the two agents of one job. An agent takes off its own notes, the person any. Nothing is deleted.
  - **What a job leaves.** A report takes `lessons` (`report` tool, `send --kind report --lesson`), which go to the board under the name of the agent that reported, and the bridge notes how each job ended. A later job that is about the same gets them in its handover.
  - `@cogitator-ai/bridge/memory`: `memoryBoard()` keeps the board with `@cogitator-ai/memory`, now an optional peer dependency. `hostBridge({ board })` takes any `FactBoard`. `cogitator bridge serve` keeps one in `memory.db` in the folder of the bridge.

  The socket has three new methods, `facts/remember`, `facts/recall` and `facts/forget`: restart a dispatcher that runs. A bridge that was given no board refuses them with `no_board` and hands jobs over with what their caller named alone.

## 0.7.0

### Minor Changes

- [#374](https://github.com/cogitator-ai/Cogitator-AI/pull/374) [`fa63550`](https://github.com/cogitator-ai/Cogitator-AI/commit/fa63550d6d8b8ef03d0531c0aa6aa9b0c4f20101) - A job can be done in a git worktree of its own, the bridge checks its result, and its work comes back when it is taken.

  - **A worktree for a job.** `createJob({ worktree: true })`, `delegate` with `worktree` and `cogitator bridge delegate --worktree` give a job a git worktree under `.cogitator/worktrees/` of the project, on a branch of its own, off the commit the caller's checkout is at, and a session started for it there. For jobs that change files while others do. No more than `limits.worktreesPerProject` (2) such jobs of a project are in progress at once.
  - **What a job changed.** When a job in a worktree is reported on, the bridge reads what it changed, committed or not, and the report says so. `diff({ job })`, the tool `diff` and `cogitator bridge diff <job>` show the files and the patch.
  - **Checks the bridge runs.** The `checks` of a job are run when it is reported on, where it was done, and the report is held back until they end and handed over with the verdict. Only commands the rules of the agent that handed the job over allow without asking are run, the rest are left out and the result is then not verified. `delegate` takes `checks` too. `job.verification` keeps each check's result.
  - **Taking the work.** `accept({ job })`, the tool `accept` and `cogitator bridge accept <job>` bring the work of a finished job into the caller's checkout as one staged change that is not committed. Files that would conflict are named and nothing is touched. `asBranch` (`--as-branch`) leaves the work as a branch. `reject` drops it. A worktree nobody came for is removed after `limits.worktreeKeepMs` (7 days), its work kept under `refs/cogitator/discarded/`.
  - **Claude Code sessions the bridge starts work in place.** They get `worktree.bgIsolation: "none"`: before, such a session moved into a worktree of Claude Code's own before its first edit, made from the default branch of `origin`, where nobody looked for its changes. Ask for a worktree of the bridge to keep a job apart.
  - `@cogitator-ai/bridge/testing`: the stand-in of `claude` moves a background session into a worktree of its own before its first edit unless its settings say it works in place, the way Claude Code does.

  A letter has one more state, `held`, before `queued`: a report whose checks still run. `BridgeJobRecord.worktree` is an object now (`path`, `branch`, `base`, `end`), it was a string nothing ever set. The socket has three new methods, `jobs/diff`, `jobs/accept` and `jobs/reject`: restart a dispatcher that runs.

## 0.6.1

### Patch Changes

- [#373](https://github.com/cogitator-ai/Cogitator-AI/pull/373) [`1349034`](https://github.com/cogitator-ai/Cogitator-AI/commit/13490342cbe2bd9455589273a5cb06cc88e25885) - The `cogitator` binary and the server of the bridge tools start several times faster. A command loads what it uses, not what every command uses.

  - **`cogitator <command>` loads that command alone.** Before, every command line loaded all 26 commands with the runtime, the LLM SDKs and the channels, about 1500 modules. Now `cogitator --version` loads 14 modules, `cogitator models` about 210, and the commands that run no agent (`init`, `doctor`, `status`, `build`, `daemon`, `wizard`, `eval`, `mcp`, `bridge`) no longer load `@cogitator-ai/core`. The help of the program and a mistyped command still load every command, to list and to suggest them.
  - **`cogitator bridge mcp` answers `initialize` without the runtime.** It loaded about 1500 modules before its first answer, now about 400. The runtime is loaded with the first tool call.
  - `@cogitator-ai/core/tool`: a new entry with `tool()`, `toolset()` and the helpers for tool names, schemas and results, the same functions the package root exports. It does not load the agents, the LLM backends or their SDKs, for a process that only defines tools.
  - `@cogitator-ai/mcp/server`: a new entry with `MCPServer`, `serveMCPTools` and `InMemoryMCPTaskStore`, without the MCP client. `MCPServer` loads `@cogitator-ai/core` with the first tool call that runs through a Cogitator of its own, and never when `toolInvoker` is set, so a server answers `initialize` and lists its tools without it.
  - `@cogitator-ai/channels/assistant-config`: a new entry with `AssistantConfigSchema` and its types alone, for a tool that reads or checks `cogitator.yml` without the channels.
  - `@cogitator-ai/bridge/tools` takes `tool()` from `@cogitator-ai/core/tool`, so it needs a `@cogitator-ai/core` that has this entry.

- Updated dependencies [[`1349034`](https://github.com/cogitator-ai/Cogitator-AI/commit/13490342cbe2bd9455589273a5cb06cc88e25885)]:
  - @cogitator-ai/core@0.79.0
  - @cogitator-ai/a2a@0.12.0

## 0.6.0

### Minor Changes

- [#372](https://github.com/cogitator-ai/Cogitator-AI/pull/372) [`e545750`](https://github.com/cogitator-ai/Cogitator-AI/commit/e54575092293ad8e768aee986aed7aceb3effb10) - Sessions of Claude Code take part in permission requests, and sessions the bridge starts get rights of their own.

  - **A Claude Code session the bridge starts asks leave through it.** It gets a `PermissionRequest` hook, `cogitator bridge permit`: a call its mode and rules would show the permission dialog for becomes a request on its job, decided by the agent that handed the job over or by the person. Before, such a session stopped at its first dialog and waited there until its job failed. `claudePermitHook()` are the settings, `claudePermissionCall()` reads the hook's input, `askLeave()` asks and waits. A hook that stops waiting takes its request back (`withdraw()`, the socket method `letters/withdraw`), so an answer that comes late is refused.
  - **An agent that waits for a person at its own window says so.** `stuck()` tells whoever handed it a job that the job stands still, and the person through their route (`PersonRoute.tell`). For Claude Code a `Notification` hook for permission prompts runs `cogitator bridge stuck`, and `cogitator bridge install` adds it. A background session is also noticed in what `claude agents --json` lists. Codex threads fall back on the reply timeout.
  - **Rights of the sessions the bridge starts.** A Claude Code session starts in `acceptEdits` mode: it changes files in the folder of its job without asking, and asks for the rest. `bridge serve --claude-mode` and `COGITATOR_BRIDGE_CLAUDE_MODE` choose another mode. `providerSessions()` starts its turns in `acceptEdits` too.
  - `@cogitator-ai/bridge/testing`: the stand-in of `claude` imitates permission dialogs. A `bash: <command>` or `edit: <path>` line of a turn is decided by the mode, the rules, the `PermissionRequest` hooks and, when none settles it, a dialog that `answerPermission()` answers. The session is listed as blocked on a permission prompt from the moment a call needs leave, also while a hook still decides, the way Claude Code lists it.

  A Claude Code session the bridge starts now gets `--permission-mode acceptEdits` unless `claudeCodeAdapter({ permissionMode })` says otherwise, and `providerSessions()` defaults to `acceptEdits` instead of `default`: pass the mode you want to keep the old behaviour. `cogitator bridge install` adds a third hook to a project's `.claude/settings.local.json`, run it again to get it.

## 0.5.0

### Minor Changes

- [#364](https://github.com/cogitator-ai/Cogitator-AI/pull/364) [`e316753`](https://github.com/cogitator-ai/Cogitator-AI/commit/e316753a19d944e41d91ffe1250ea008b1e15f7e) - An agent that carries a job out asks leave for a call through the bridge, and the person is reached when the answer is theirs.

  - **Leave for a call**: a `permission` letter names its call (`ask`: the tool, and the command, files or address it touches), and the answer carries a `verdict`. The bridge decides whose answer it takes by the rights of the agent that handed the job over: forbidden by its rules, the call is refused at once, allowed, that agent answers, left to a person, only the person can allow it. So an agent never gets leave another agent does not have itself, and a job handed over from inside a job is bound by every agent up the chain. `verdict()` lets the one who asked wait for the decision.
  - **Rights from the project's settings**: `settingsRights()` in the new `@cogitator-ai/bridge/rights` entry reads them from the permission settings of the job's project (`.claude/` and `.cogitator/`) with the permission engine of core, in the permission mode the agent told the bridge it runs in. `hostBridge({ rights })` takes any judge.
  - **Hosted agents ask instead of failing**: a tool call of a runtime agent that needs approval, and a call of an ACP agent its provider's rules do not settle, become such a request (`HostedTurnContext.approve`, `permissionAskOf()`). Before, the run paused and failed its job, or the call was refused without a word.
  - **The person**: `escalate()` passes a question or a request on to the person, `personAnswer()` takes what they said. `inboxRoute()` shows what waits for them in an `experimental_Inbox`, `channelRoute()` in a chat of a messaging channel with Allow and Refuse buttons, `personRoutes()` joins routes, `hostBridge({ person })` takes them. Waiting for the person does not spend the job's time, and they have a limit of their own (`personReplyTimeoutMs`, 4 hours, then a reminder, then the job fails).
  - **Command line**: `cogitator bridge asks` lists what waits for the person, `allow`, `deny` and `reply` answer it, and refuse to run inside a session of an agent. `bridge send --decision allow|deny|person` is the same for a session without the tools. `bridge serve` and `daemon start --bridge` read rights from the settings, keep the inbox in `inbox.json` next to the database, and reach a Telegram chat when `COGITATOR_BRIDGE_TELEGRAM_TOKEN` and `COGITATOR_BRIDGE_TELEGRAM_CHAT` are set.
  - The `answer` tool takes a `decision`: `allow`, `deny`, or `person` to leave a request or a question to the user.

  The store's schema goes to version 2 and the socket's protocol to version 2: a database of version 1 is upgraded when the new dispatcher first opens it, and an older dispatcher refuses a database or a client of the newer version, so restart the dispatcher after updating. `BridgeCalls` has a new `verdict` method, `PersonRoute.settle` and `forPerson()` are new, and `Letter` has new optional fields: code that implements `BridgeCalls` by hand adds the method. `@cogitator-ai/bridge/rights` needs `@cogitator-ai/core`, an optional peer of the package.

## 0.4.0

### Minor Changes

- [#362](https://github.com/cogitator-ai/Cogitator-AI/pull/362) [`b108f58`](https://github.com/cogitator-ai/Cogitator-AI/commit/b108f5808a94769e3bfb8b657735ebed0747cc9c) - Agents call the bridge with tools of their own, and `cogitator bridge install` sets Claude Code and Codex up.

  - **Tools**: `bridgeTools()` in the new `@cogitator-ai/bridge/tools` entry are the bridge as tools of an agent: `delegate`, `ask`, `answer`, `report`, `note`, `inbox`, `job`, `jobs`, `cancel` and `agents`. None waits for another agent. `cogitator bridge mcp` serves them over MCP with `BRIDGE_INSTRUCTIONS`, which say how the tools go together and whose a letter of the bridge is.
  - **Sandboxes**: a harness runs a server of tools outside the sandbox of its session, so a Codex thread in `workspace-write` or `read-only` asks, answers and reports where its shell commands cannot reach the bridge's socket. The tools say they destroy nothing and stay on this machine, so Codex runs them without an approval.
  - **Which session calls** is read from every tool call, not once: the thread Codex names in `_meta`, or for Claude Code, which keeps one server across `/clear`, the session a `PreToolUse` hook adds to the arguments (`cogitator bridge caller`, `claudeToolsHook()`).
  - **Sessions the bridge starts** get the tools with them: pass `toolsServer` to `claudeCodeAdapter()` and `codexAdapter()`. `bridge serve` and `daemon start --bridge` do.
  - **Setup**: `cogitator bridge install [claude|codex|all]` lists every change and makes them after a yes: the server of tools, the hooks and the rule for the tools in the project's `.claude/settings.local.json`, the notes in `CLAUDE.md` and `AGENTS.md`. `--user`, `--take-jobs`, `--no-notes`, `--no-allow`, `--dry-run`, `--yes`. `cogitator bridge uninstall` takes it out again. `claudeSetup()` and `codexSetup()` are the same as steps to show and apply.
  - **Doctor** shows whether the sessions of a folder have the tools and the hook that names them.
  - `bridge wait --tools` tells a woken session to reply with the tools. A folder of the bridge that is not the default one is written into the command of the server and the hooks.
  - `@cogitator-ai/bridge/testing`: the stand-ins of `claude` and `codex` run MCP servers the way the real ones were measured to, and keep the commands of a sandboxed Codex thread from sockets and from writing outside its folder.

  `DispatcherStatus` has a new `startable` field and `FakeTurn` a new `tools` field: code that builds either by hand adds them. `@cogitator-ai/bridge/tools` needs `@cogitator-ai/core`, an optional peer of the package.

## 0.3.0

### Minor Changes

- [#357](https://github.com/cogitator-ai/Cogitator-AI/pull/357) [`0ceef78`](https://github.com/cogitator-ai/Cogitator-AI/commit/0ceef7830a095120438e9de551177078da83a599) - The agent bridge reaches sessions where they live: adapters for Claude Code, Codex and for agents the bridge hosts itself.

  - **Claude Code**: `claudeCodeAdapter()` starts a background session for a job (`claude --bg`) after checking that Claude Code trusts the folder. A session wakes for its mail through a hook of its own: after every turn a background `Stop` hook waits at the bridge (`cogitator bridge wait`) and wakes the session with the letter, so the session stays free to talk to. `claudeWaitHook()` is the hook for the sessions you open yourself.
  - **Codex**: `codexAdapter()` hands letters to the queue of a thread (`codex queue --resume`) and starts threads with `codex exec`. A letter queued while no Codex daemon runs is noted in the journal with the command that starts it, the bridge never starts it. A thread the bridge starts works in the `workspace-write` sandbox and cannot reach the bridge from there, so the bridge reports its final answer for it. `bridge serve --codex-sandbox` or `COGITATOR_BRIDGE_CODEX_SANDBOX` names another sandbox.
  - **Hosted agents**: `hostedAdapter()` runs sessions in the host. `cogitatorSessions()` hosts an agent of the runtime on any model, with steering in the middle of a turn, `providerSessions()` an agent behind a session provider such as `AcpAgentProvider`, bound to the folder it works in. The agent's answer is the job's report, a canceled job stops its run, and a run that pauses for an approval fails its job.
  - **Waiting for mail**: `BridgeDispatcher.wait()`, `BridgeClient.wait()` and `waitForMail()` resolve the moment a letter is queued for a session. A letter stays queued until `delivered()` confirms it.
  - **Presence**: a session its harness lists as running is not retired for being silent, and one that was listed and is missing two checks in a row fails its jobs then, not after the reply timeout.
  - **Adapter port**: `deliver` is optional and may return a note for the journal, and an adapter can add `identify`, `liveSessions`, `health`, `attach` and `close`. The port types moved to their own module and are still exported from the package root.
  - **`@cogitator-ai/bridge/testing`**: `adapterConformanceCases()` is the adapter contract as test cases, `installFakeHarnesses()` puts stand-ins of the `claude` and `codex` commands on a `PATH`.
  - **CLI**: `cogitator bridge doctor` checks the dispatcher and both harnesses and says what to fix, `bridge wait` is what a wake hook runs, `bridge delegate`, `bridge send`, `bridge inbox` and `bridge cancel` call the bridge from inside a session. `bridge serve` and `daemon start --bridge` run the Claude Code and Codex adapters.
  - Folders are compared by their real path, so a project reached through a symlink is one project. `CLAUDE_CONFIG_DIR` is honored.
  - A letter with a NUL character is refused: no harness can be handed one.

  `DispatcherStatus` has a new `waiting` field and `BridgeLimits` a new `presenceCheckMs`: code that builds either by hand adds them.

## 0.2.0

### Minor Changes

- [#356](https://github.com/cogitator-ai/Cogitator-AI/pull/356) [`531fc88`](https://github.com/cogitator-ai/Cogitator-AI/commit/531fc881e170d3420892f9a1246bea4e79dd6b16) - The agent bridge (experimental): Claude Code, Codex and other agents hand each other jobs, ask questions on the way and report back, each staying in its own window. Nobody waits: a job is handed over, its number comes back at once, and whatever comes later arrives as a letter.

  New package `@cogitator-ai/bridge` with the core of it:

  - **A dispatcher, not a model.** `BridgeDispatcher` keeps jobs, letters and the address book, finds who a letter is for and applies the limits. It never calls a model. One runs per machine and serves every project: `hostBridge()` opens the store, takes its lease and serves a unix socket (a named pipe on Windows), and `BridgeClient` talks to it.
  - **Jobs are A2A tasks.** A job runs on the `TaskManager` of `@cogitator-ai/a2a`: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, plus whether its checks confirmed the result, which only the process hosting the dispatcher can record (`recordVerification`), never an agent over the socket. It carries who handed it over, who carries it out, the project, the folder, checks, a budget and its depth.
  - **Letters.** A `task`, `question`, `answer`, `report`, `note` or `permission` request, moving `queued`, `delivered`, `read`, `handled`. A letter sent again under the same id is not delivered twice. Every letter starts with a line saying which job it belongs to and who wrote it, since in a harness window it looks like the user typed it.
  - **An address book.** A session registers itself from what its harness put in the environment (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) and is reached by name: `codex` for the only Codex session of the project, `codex:reviewer` for one of several, `codex:new` for a fresh one. A session that has been silent for 12 hours with no job in progress is taken for gone, and is back the moment it calls again.
  - **Limits.** Jobs nest three deep at most, a job has a budget of letters and time, a letter that repeats the previous one is held back, and so is a job the same agent already has. An agent has 20 jobs out and hands over 60 an hour at most. A letter nobody reacts to gets a reminder and then fails the job, and a job that is over takes the jobs handed over from inside it along.
  - **A signature nobody can fake.** Only the first line of a letter is a signature: a title cannot add fields to it, a body line that looks like one is quoted, and what the bridge repeats of an agent's words is quoted too.
  - **A journal.** Every letter, delivery and change of a job is appended to a journal the database keeps from being changed.
  - **One writer.** Which dispatcher owns the store is decided by the store: a lease taken in a transaction and checked inside every write. The second dispatcher to start is refused, one whose process is gone is replaced at once.
  - **Adapters.** `BridgeAdapter` is how the bridge reaches the sessions of a harness: push a letter, start a session for a job. Without one a session reads its inbox itself.

  In the CLI:

  - `cogitator bridge serve` runs the dispatcher, `cogitator bridge status` shows it with its sessions and jobs, `cogitator bridge log [--job N] [--follow]` reads the journal.
  - `cogitator daemon start|restart|install --bridge` makes the assistant daemon host the dispatcher too. A restart keeps it, `restart --no-bridge` stops it.

  The state is kept in SQLite: install `better-sqlite3` next to `@cogitator-ai/bridge` (the CLI already has it).

### Patch Changes

- Updated dependencies [[`5456d74`](https://github.com/cogitator-ai/Cogitator-AI/commit/5456d7425d4e846041d8d4b015fb0b0c22926b94)]:
  - @cogitator-ai/a2a@0.12.0
