# @cogitator-ai/mcp

## 19.7.2

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0
  - @cogitator-ai/core@0.68.0

## 19.7.1

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0
  - @cogitator-ai/core@0.67.0

## 19.7.0

### Minor Changes

- [#295](https://github.com/cogitator-ai/Cogitator-AI/pull/295) [`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b) - Decide tool calls by rules before anyone is asked, run agents in permission modes from plan to bypass, keep an audit log of every decision, and give sessions budgets that pause a run instead of failing it.

  Nothing in a run changes until you set `permissions` (on the runtime, an agent or a run) or `budget`: a call asks exactly when its tool needs approval, as before, no decision is logged, and an approval's `updatedArguments` is ignored with a warning. The few changes outside runs are listed under Breaking.

  Breaking:

  - `InterruptKind` is now `'approval' | 'input' | 'plan' | 'budget'`, and the `kind` of `PendingInterrupt` on the wire (`interrupt-required`, the JSON answer of a paused run) can be `plan` or `budget`. A client or a `switch` over the kind that knew only `approval` and `input` handles the new kinds or ignores them: they come only from runs that use plan mode or budgets.
  - The `allowed-tools` of a `SKILL.md` is split at commas too, and never inside parentheses, so `Bash(git status *), Read` reads as two rules. Before, `Read, Grep` read as `Read,` and `Grep`.
  - `read_file`, `list_files`, `glob` and `grep` of `workspaceTools()` now declare `annotations: { readOnlyHint: true }`, which an MCP server exporting them advertises.
  - `serveAgents()` and `agentTools()` of `@cogitator-ai/mcp` register `<agent>_resume` for every agent, not only for agents with a tool that needs approval: rules of the runtime can make any call ask. A client listing the tools sees one more per agent.
  - `RunHandle.permissionMode` and `setPermissionMode()` are optional in the interface, so code that builds its own `RunHandle` keeps compiling. `cogitator.start()` returns a handle that has both.

  New:

  - Permission rules in the grammar of Claude Code's `permissions` settings, `allow`, `ask` and `deny` lists of `Tool` or `Tool(specifier)`: `Bash(git push *)` (and `Bash(git push:*)`), `Edit(src/**)`, `Read(//etc/**)`, `Read(~/.ssh/**)`, `mcp__github__*`, `WebFetch(domain:example.com)`, `Agent(Explore)`, `send_email(to:*@example.com)` in deny and ask rules, globs of tool names in deny and ask rules. Claude Code's names map onto Cogitator's tools by what they touch, a tool's own name works as it is, and the names without a counterpart (`MultiEdit`, `NotebookRead`...) match nothing with a warning. The docs list the differences from Claude Code.
  - Command lines are tokenized as a POSIX shell reads them (quotes, escapes, line continuations, redirections glued to words) and rules match each command's argument vector. An allow needs every command of the line fully understood (no substitutions, expansions, here-documents, subshells, control flow, programs that run other code, `git` global options or `find -exec`), covered by an allow rule, without unsafe variables (`exec`'s `env` too), with its working directory and the files it writes inside the workspace. A deny or ask rule matches every command the line may run, wrappers (`sudo`, `env`, `nice`, `timeout`, `xargs`, `exec`...) taken off, programs by base name, `sh -c` and `eval` read again and `git` without its global options. Globs and brace expansion, interpreters given code (`python3 -c`, `node -e`, `awk`...), `busybox`, `xargs` and anything left open are not understood, ANSI-C strings are decoded and program names compared without case on macOS and Windows. A line the parser does not fully understand asks when a `Bash` deny or ask rule or a `Read`/`Edit` deny rule could apply, also under a bare `Bash` allow, and is refused in the modes that never ask (`bypassPermissions`, `dontAsk`). Shell rules are best effort, the docs say what they cover and recommend a sandbox for a guarantee. `Read` rules count every word of a command as a file it may read (`paste x`, `dd if=x`, `git show HEAD:x`) and refuse recursive readers (`grep -r`, `rg`, `tar`) over a directory a denied path may lie in, `Edit` rules check the files commands write (`tee`, `cp`, `sed -i`, redirections), and `grep`, `glob` and `list_files` leave out the files a `Read` deny covers (`ToolPermissionsView.canRead()`). Path rules use gitignore patterns, compare the path with `..` resolved and with symlinks followed (an allow needs both to match, a deny either), refuse backslashes used as separators and compare Windows paths as `/c/...`. A deny of any layer wins, then ask, then allow, and a bare deny also takes the tool out of the model's tool list.
  - `ToolConfig.access: { kind: 'read' | 'edit' | 'command' | 'fetch' | 'search' | 'agent', paths?, subtree?, command?, cwd?, env?, url?, agent? }` says what a call touches, so `Read(...)`, `Edit(...)` and `Bash(...)` rules and the modes cover tools of your own. The workspace tools (their paths resolved against the workspace they are bound to), `exec`, the `file_*` tools and `agentAsTool()` declare it, `restrictFileTools()` and `withParsedArguments()` keep it. `ToolConfig.mcp: { server, tool }` names the MCP tool behind a tool, which `@cogitator-ai/mcp` sets, so `mcp__<server>__<tool>` rules match whatever `namePrefix` the tool got.
  - Layers, highest first: `managed` (`managed-settings.json` and `managed-settings.d/*.json` in Cogitator's and Claude Code's system directories), `session` (rules in code, "always allow" answers for the session, the `allowed-tools` of active skills), `local` (`.claude/settings.local.json`, `.cogitator/settings.local.json`), `project` (`.claude/settings.json`, `.cogitator/settings.json`) and `user` (`~/.cogitator/settings.json`, `~/.claude/settings.json`). `permissions.settings: true` (or `{ root, userDirs, managedDirs, layers, trusted }`) reads the files, again once one changes, skipping broken files and entries with a warning. As in Claude Code a project or local file cannot set `defaultMode` to `auto` or `bypassPermissions`, `disableBypassPermissionsMode` and `disableAutoMode` work from any file, `allowManagedPermissionRulesOnly` in a managed file makes its rules the only ones, and `trusted: false` ignores what an untrusted project grants (the allow rules, extra directories and mode of its project and local files). The `allowed-tools` of skills found in the workspace count only with `trusted: true`.
  - Modes: `default` (an edit asks unless an allow rule covers it), `acceptEdits` (edits inside the workspace and `mkdir`, `touch`, `mv`, `cp` on workspace paths, their options read exactly, run without asking), `dontAsk` (what would ask is refused), `plan` (only the runtime's read-only tools and read-only commands with options known to only read run, never what an MCP server claims, switching a run into it offers `exit_plan_mode`, the model presents its plan with the `exit_plan_mode` tool, the run pauses with an interrupt of kind `plan` holding the plan in `details.plan`, and an answer `{ approved: true, mode? }` (`default`, `acceptEdits` or `dontAsk`, the modes that ask less are the host's to set) carries it out, `{ approved: false, feedback? }` keeps planning), `auto` (a classifier decides each call that would ask, `permissions.classifier: { model, instructions?, timeout?, transcriptMessages? }` or your own `{ classify }`, with its reason in the log, an ask rule still asks and a failing classifier falls back to asking, the classifier reads the arguments escaped and never the tool results, and arguments too long to read whole ask) and `bypassPermissions` (every call runs but what a deny rule refuses, only for isolated environments). The mode comes from the run, the paused run, the agent, the runtime or the settings, and `RunHandle.setPermissionMode()` switches it while the run goes on (`RunHandle.permissionMode` reads it).
  - `resolvePermission(tool, args, context)` is the one decision behind the run loop, `invokeTool()` and `agentAsTool()`, whose inner run gets the caller's mode and session rules (`ToolContext.permissions`). A handoff the rules refuse does not hand over, after one that runs the rules of the agent the run went on as apply, and `invokeTool(tool, args, { agent })` applies the agent's. A refused call answers the model with `Permission denied: <reason>` and `errorCode: 'PERMISSION_DENIED'`. A request that asks carries `reason`, `rule`, `suggestedRule` and `mode`. Every decision, the automatic ones too, is saved to the thread as an `approval` entry (`{ toolCallId, toolName, decision, reason, decidedBy, mode, rule?, updatedArguments?, remembered? }`) and reported to `RunOptions.onPermissionDecision`, and `invokeTool()` returns it in `result.permission`.
  - With permissions set up, an approval may answer `{ approved: true, updatedArguments }`: the call runs with them once they pass the tool's schema and the rules again, and a `defaultDecision` never changes the arguments of the calls it answers. `{ approved: true, remember: true | { rule?, layer? } }` saves an allow rule ("always allow") to `permissions.rememberIn` (default `local`, the session without settings files): only the suggested rule or the exact call, and only to a layer of `permissions.rememberLayers` (default `session` and `local`). File layers are written to `.cogitator/settings.local.json`, `.cogitator/settings.json` or `~/.cogitator/settings.json`. A paused run keeps its mode, its own rules and the rules allowed for the session in `checkpoint.permissions`, and the calls the rules refused in `checkpoint.turn.denied`: resume it with the same or a newer version. A resume decides the calls the rules, the mode or the classifier allowed again under its own mode and rules (`checkpoint.turn.automatic`), and holds the calls a person approved to its deny rules and mode. A `cd`, `pushd`, `popd` or `builtin cd` followed by more commands makes the rest of the line not understood (a directory change is never followed), rules match the arguments as the tool's schema reads them, and plan mode takes `git` commands as read-only only in a trusted workspace (`permissions.settings.trusted: true`), `git diff`, `git show` and `git log -p` only with `--no-ext-diff --no-textconv`, and of `git branch`, `tag`, `remote`, `stash` and `worktree` only the listing forms. Arguments a `wrapToolCall` middleware changes a call to are decided again after it (a deny wins, an ask asks again, `checkpoint.turn.changed`), a handoff into a workspace whose settings disable the current mode falls back to `default`, and the run limits of a parent count what its delegates spent. Path rules compare names in NFC and without case where the file system ignores it (probed once per workspace root, `ignoreCase` and `pathsIgnoreCase()` to decide it yourself), every call of a turn is decided again right before it runs, so a mode switched mid-turn stops the later calls, a budget the host passes to `resume()` also wins over a lifted limit, and a tool call counts against `maxToolCalls` only once its tool starts. A command that touches a whole directory (`rm -r`, `rmdir`, `chmod -R`, `chown -R`, `chgrp -R`, `cp -r`, `mv`, `find`, `grep -r`, `rg`, `ag`, `du`, `ls -R`, `tar`, `zip -r`, `unzip`, `rsync`, `scp`) has everything inside it as its target, a recursive reader without a path reads the working directory, the options of these commands are read exactly so a value is never taken for a directory, and an unknown option makes the command not understood. `ToolAccess.subtree` lets a tool say the same (`file_delete` and `file_list` with `recursive: true`). A resume budget changes only the limits it names, and the model calls of the `auto` classifier count in the run's usage, cost, budgets and cost routing. Plan mode reads commands from a strict list with their options and operands (`printf -v` and a `date` that sets the clock are not read-only), and a builtin that changes the shell state (`export`, `set`, `alias`, `read`, `printf -v`, a bare assignment...) in a line of several commands makes the line not understood in every mode. A call is decided again once it holds its locks, right before its tool starts, the tool call allowance (the run's and its callers') is checked again then, what the memory upkeep after a run spends counts in its budgets and the session's spending, and a forced `toolChoice` naming a tool a bare deny hides is not forced. `grep`, `glob` and `list_files` withhold files a `Read` ask rule covers too and say how many (`withheld`), a shell read over a directory with such a file inside asks, agent budgets go by the agent's `id`, else its name, so a new instance of the agent keeps its spending, records keyed by agent names and other user strings have no prototype, and a person's approval holds through the final check right before a call runs in `dontAsk` mode. `invokeTool()` decides a call again right before its tool starts, `agentAsTool()` passes the caller's rules with the root and working directory their path patterns start from (`ToolPermissionsView.inherited`, `RunOptions.permissions.inherited`), and runs of one thread at the same time in one process share one live count of the session's spending. Arguments an approval of changed arguments gives go through the guardrails' tool call filter again, agent snapshots keep inherited rules, the `auto` classifier is not asked twice for one call, and rules a person allowed for a session apply to its next runs without permissions of their own. `~` and `~/` read as the home directory in commands and command patterns (`~user` is not understood), wrappers and `env` are unwrapped to a fixed point so their order never hides an assignment, MCP tools always carry their origin (`server: ''` for a nameless server) so their annotations are never trusted, the budget is checked before each call of the `auto` classifier, and `invokeTool()` reports the final decision in `result.permission`. A budget the host passes to `resume()` wins over a raised limit, and settings drop-in directories are watched for new files. `cp`/`mv` destinations are checked per source, inline variable assignments must be safe in every mode, too many paths on a line ask, `restrictFileTools()` checks paths where the wrapper reads them, budgets on agents anywhere down a handoff chain keep the session's spending, and a spending record memory refused is not lost to a staler one.
  - Session budgets: `budget: { session: { maxCostUsd, maxTokens, maxToolCalls }, agent, warnAt, onWarning }` on the runtime or a run, and `AgentConfig.budget`. A run that reaches a limit pauses with an interrupt of kind `budget` (`details: { scope, metric, used, limit }`) before its next model call or tool turn, and `{ action: 'stop' }` ends the run with `result.budgetStop`. Raising a limit is the host's decision: resume with a higher `budget`, or set `budget.allowRaise: true` to let an answer `{ action: 'continue', limit }` raise it (for the session when it is a session or agent limit) or `{ action: 'continue' }` go past it for the run. A session is a thread. A paused run keeps its own budgets in `checkpoint.budget.limits`, an agent's own `budget` keeps the session's spending too, and what an agent run through `agentAsTool()` spends (money, tokens and tool calls, its calls refused once the caller's tool call budget is spent) is charged to the caller's session. Runs of one thread that end at the same time add up their spending instead of overwriting it. With `limits.onExceeded: 'interrupt'` the cost routing check before a run pauses it too. The spending is kept in the thread's metadata (`budget`, without memory in the process) and returned as `result.sessionSpend`. `RunOptions.onBudgetWarning` hears warnings past `warnAt` (default 0.8).
  - `limits.onExceeded: 'interrupt'` makes `limits.maxTokensPerRun` and the cost routing budgets pause the run the same way, scopes `run`, `hour` and `day`, instead of failing it with `RUN_TOKEN_LIMIT_EXCEEDED` or `BUDGET_EXCEEDED`, which stays the default.
  - `InterruptRequest` takes `kind: 'plan'` and `details`, and `RunInterrupt.details` carries them. `AgentConfig.permissions` and `budget` travel in `serialize()`, not in the agent wire format: the receiving side decides what its tools may do.
  - `@cogitator-ai/core` exports `resolvePermission`, `PermissionRuleSet`, `suggestRule`, `ruleAllowsCall`, `parseRule`, `parseCommandLine`, `matchesCommandPattern`, `compilePathPattern`, `pathsIgnoreCase`, `readAllowed`, `rememberableRules`, `loadPermissionSettings`, `addAllowRule`, `rememberFile`, `modelClassifier`, `parseClassification`, `EXIT_PLAN_MODE`, `BUDGET_RESPONSE_SCHEMA`, `BUDGET_STOP_SCHEMA` and `SESSION_BUDGET_KEY`. `@cogitator-ai/types` adds `PermissionMode`, `PermissionsConfig`, `PermissionOptions`, `PermissionDecision`, `PermissionDecisionEvent`, `PermissionRuleRef`, `PermissionLayerSettings`, `InheritedPermissionRules`, `PermissionClassifier`, `ToolAccess`, `ToolMcpOrigin`, `ToolPermissionsView`, `ToolApprovalRemember`, `SessionBudgetConfig`, `BudgetLimits`, `BudgetUsage`, `BudgetWarning`, `SessionSpend`, `BudgetResponse` and `PlanResponse`.
  - Server adapters: `approval-required` approvals and paused answers carry `reason`, `rule` (the rule text, never the file it came from), `suggestedRule` and `mode`, interrupts carry `details`, and resume decisions take `updatedArguments` and `remember` (the Fastify and Tetsu schemas no longer drop them). The OpenAPI document and the conformance suite describe them. `useCogitatorChat` of `@cogitator-ai/next` gets `approveAlways()`, and `resume()` of both hooks sends `remember` and `updatedArguments`.
  - `@cogitator-ai/config` reads `permissions`, `budget` and `limits.onExceeded` from config files.
  - Channels: the approval prompt says why a call asks, an "always" reply (`approvals.alwaysWords`, default `always` and `всегда`) or the new "Always allow" button (`cogitator:always`) approves with `remember: true` when the request suggests a rule, and a plan question shows the plan.
  - Cogitator Studio shows why an approval asks and its rule, and offers "Always allow" with the rule it saves. `@cogitator-ai/a2a` carries `updatedArguments` and `remember` in approval answers, the reason in the status text and the plan of a plan question, and `@cogitator-ai/mcp` adds the reason to the elicitation and sets `tool.mcp` on imported tools (the new `server` option, else the name the server reports). `allowRemember: true` in its server options offers an `always` choice and `remember` on `<agent>_resume`, off by default so the client model cannot grant itself standing permissions.

### Patch Changes

- Updated dependencies [[`cd16fff`](https://github.com/cogitator-ai/Cogitator-AI/commit/cd16fff8ebadaf53b013371877a47a4546817e3b)]:
  - @cogitator-ai/types@0.76.0
  - @cogitator-ai/core@0.66.0

## 19.6.1

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/core@0.65.0

## 19.6.0

### Minor Changes

- [#293](https://github.com/cogitator-ai/Cogitator-AI/pull/293) [`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8) - Steer a run while it goes on, choose what a second message does to a busy thread, pause a run on a question a tool asks, and cancel a run without losing what it showed or did.

  Behavior changes, none of which needs a code change:

  - An aborted run (its `signal`, its timeout, `handle.abort()` or a newer run that interrupts it) now leaves more in its thread: the text it already streamed as an assistant message with `metadata.interrupted: true`, the results of tool calls that finished before the abort, and `Aborted before dispatch` for the calls it never started. Before, it left only its `interrupt` entry. A tool that ignores the signal still runs on, its late result is never written.
  - History read from memory now answers a tool call left without a result (a crash, an abort while the tool ran) with `The run stopped before this tool call returned: outcome unknown, verify before retrying`, instead of dropping the call from the assistant message. The model learns the call may have run. The log is not rewritten. Code that sends `history` of its own is not affected.
  - A paused run's `output` is the text of its last assistant message. For a pause on approvals this is what it always was.

  New:

  - `cog.start(agent, options)` returns a `RunHandle`: `steer(message)` adds a user message after the current step's tool calls (none is skipped) and wakes an agent about to stop, `followUp(message)` runs once the agent would stop (with a fresh `maxIterations`), `inject(message)` adds context to the next model call without waking the agent (one left at the end is saved to the thread), `abort(reason?)` stops the run and returns what it did not deliver, and `result` is what `run()` returns. `queue: { steering, followUp }` takes queued messages `'one-at-a-time'` (default) or `'all'` at once. Delivered messages are saved as `message` entries with `metadata.queued`, so a later run reads them as history, and a run that pauses returns the rest in `result.undelivered`. `run()` is unchanged.
  - `multitaskStrategy` (`RunOptions`, or `CogitatorConfig` for every run) says what a run does when another run of the runtime goes on in its thread, with the names of LangGraph's `multitask_strategy`: `enqueue` waits, `reject` fails with `THREAD_BUSY` (409), `interrupt` aborts the running one (it fails with `RUN_INTERRUPTED`, 409), `rollback` interrupts it and runs on a branch from where it started, so the thread goes on as if it never happened. Unset, runs of one thread go on side by side as before. A run started from a tool call of the run going on is never held back, other runs of the same trace follow the strategy.
  - Tools pause a run to ask a person with `context.interrupt({ reason, message, responseSchema, expiresAt })`. The run returns `status: 'paused'` with the question in `result.interrupts` (`id`, `kind: 'input'`, `reason`, `message`, `responseSchema` as JSON Schema, `expiresAt`, `toolCallId`, `toolName`), and `cog.resume(agent, thread, { responses: { [id]: answer } })` checks the answer against the schema and runs the tool again, where `interrupt()` returns it, parsed by a Zod schema. A wrong answer fails the resume with `INTERRUPT_ANSWER_INVALID` (400, `details.interruptId`), one after `expiresAt` with `INTERRUPT_EXPIRED` (410), and the run still waits. Finished calls of the same step keep their results. The pause and the resume are logged as `interrupt` entries (`status: 'paused' | 'resumed'`).
  - The run result wire format (`toAgentWireRunResult`) keeps `interrupts`, and `AgentRunPausedError` says when a workflow node or a swarm turn paused on questions instead of approvals.
  - Tool calls of a step run one after another, and the step stops at the first question: the calls after it run once the answer came. With `parallelToolCalls: true` the other calls run before the answer. Calls that finished keep their results, the checkpoint lists them in `turn.completed`, and a handoff among them hands over once the resumed step is done. A resume that leaves a question unanswered pauses on it again as it was asked, its tool not run again and its `expiresAt` unchanged. Answers are checked with the tool's Zod schema (refinements included) while the process that asked keeps it, else with the stored JSON Schema of the schema's input side.
  - A run with a `multitaskStrategy` is refused with `THREAD_ACCESS_DENIED` before it touches another user's run going on in the thread. A follow-up or steering message starts a new task, so its first tool call is never taken for a duplicate. `handle.abort()` is final: what it returns was never delivered or saved, also when it comes after the last model turn.
  - Queued messages pass the run's `beforeRun` input checks (PII in `block` mode, prompt injection, input guardrails, your own hooks) before they reach the model or the thread, injected messages saved at the end too. A refused message is dropped and listed in `handle.refused` with its error (`onRefusedMessage` in the options of `start()`), the run goes on.
  - A question that expired without an answer no longer holds the run: a resume answers its tool call with `Nobody answered "<message>" before it expired`, so other questions of the step can be answered alone. Calls of a step that never ran get "Not started" when the user moves on. A run whose signal aborted already, and a run of another user on a thread whose run has not written anything yet, change nothing on the thread.
  - `saveInterruptedReply: false` keeps an aborted run from saving its streamed text, and the voice runner uses it, so an interrupted voice turn keeps only what the caller heard, as before.
  - Resume a checkpoint with the same or a newer version: from this release the turn of a pause on a question lists all its calls, the finished ones in `turn.completed`, and an older version would run those again. The checkpoint stays `version: 1`.
  - `multitaskStrategy` is part of the config schema, so `defineConfig()` and `cogitator.yml` keep it.
  - Approvals are interrupts of `kind: 'approval'` keyed by tool call id: `result.interrupts` lists them, and `responses` decides them as `decisions` does. `decisions`, `defaultDecision` and `pendingApprovals` work as before. `RunCheckpoint` stays `version: 1` with optional `interrupts` and `iterationLimit`, older checkpoints resume as they did.
  - `@cogitator-ai/core` exports `ABORTED_BEFORE_DISPATCH`, `OUTCOME_UNKNOWN`, `repairUnansweredToolCalls()`, `APPROVAL_RESPONSE_SCHEMA` and `isToolInterrupt()` (rethrow it from a `wrapToolCall` middleware that catches tool errors). `@cogitator-ai/types` adds `RunHandle`, `StartOptions`, `QueuedRunMessage`, `MultitaskStrategy`, `RunInterrupt`, `InterruptRequest`, `ToolContext.interrupt` and the error codes `THREAD_BUSY`, `RUN_INTERRUPTED` and `INTERRUPT_EXPIRED`.
  - Server adapters (Express, Fastify, Hono, Koa, Tetsu, Next.js) take `multitaskStrategy` in run, stream and WebSocket run requests and `responses` in resume requests. A paused run that waits on questions of its tools carries them in `interrupts` of the JSON answer, the `finish` event and the WebSocket `complete` event, and its stream sends the new `interrupt-required` event instead of `approval-required`. `@cogitator-ai/server-shared` adds `runRequestRunOptions()`, `MULTITASK_STRATEGIES`, `createInterruptRequiredEvent()`, `toPendingInterrupts()`, `PendingInterrupt` and their schemas, and the OpenAPI document lists the new fields. `useCogitatorChat` keeps `pendingInterrupts`, calls `onInterruptRequired`, and resumes with `resume({ responses })`. With `multitaskStrategy: 'enqueue'` or `'reject'` it no longer aborts the request in flight when a new message is sent, and a refused message shows as an error without touching the running answer. Swarm routes ignore `multitaskStrategy` in every adapter. A stream refused or interrupted this way answers `200` with an `error` event carrying the code, the JSON routes `409` (`410` for `INTERRUPT_EXPIRED`).
  - The Gateway's `queueMode` takes the run strategies too: `enqueue` (the same as `sequential`), `reject` (a message for a busy thread runs nothing, reaches the new `message:rejected` hook, is never handed back to its channel, and makes `injectMessage` reject) and `rollback` (as `interrupt`, then the new message is answered on a branch from where the stopped answer started). Every gateway run names the strategy its queue mode stands for, so the runtime's `multitaskStrategy` never contradicts the queue (`parallel` names none). `sequential`, `parallel`, `interrupt` and `collect` work as before. Cogitator Studio labels pauses on questions and their answers in the thread tree.
  - Pauses on questions of tools never resume without answers anywhere. `pendingQuestions(result)` lists them, and `AgentRunPausedError` carries them in `interrupts`. A workflow `agentNode` fails with it, also with an approval store or `approvals: false`, where it used to resume without an answer forever. Swarm turns and queued workflow jobs fail the same way, and `JobQueue.resumeAgentJob` takes `responses`. The Gateway asks the question in the chat and takes the user's next message as the answer, and the voice runner says it and takes the caller's next turn. A2A tasks wait in `input-required` with an `interrupt-request` part and take the answer back (`A2AClient.answerQuestions()`). MCP servers ask through elicitation. The OpenAI-compatible APIs, Studio and delegated `agentAsTool` runs end with an error that names the questions, and the AI SDK provider warns with them (`providerMetadata.cogitator.pendingQuestions`).
  - `parseAnswer(text, schema)` and `answerFormat(schema)` (`@cogitator-ai/types`) read a typed or spoken answer by the question's schema and say what an answer looks like. `cog.pausedRun(threadId)` lists what a thread waits on, `cog.cancelPause(threadId, { userId, reason })` ends a pause with declined results. The Gateway shows the format with the question, tells a wrong answer in plain words, cancels a question with a cancel word (`approvals.cancelWords`, `cancel` by default) or after `approvals.maxAnswerAttempts` wrong answers (3), ends an expired one, and picks up a question waiting across a restart. The voice runner reads spoken answers the same way. A2A tasks keep their paused run by task, so a new task in the same context no longer answers the wrong run (the older task ends `canceled`), an expired question fails its task and lifts the pause, and text answers are read by the schema. MCP elicitation carries the schema's limits, asks again on a refused answer (3 times at most) and waits `elicitationTimeoutMs` (10 minutes by default) instead of 60 seconds.

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0

## 19.5.31

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1

## 19.5.30

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0

## 19.5.29

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0

## 19.5.28

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1

## 19.5.27

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0

## 19.5.26

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3

## 19.5.25

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2

## 19.5.24

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1

## 19.5.23

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0

## 19.5.22

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0

## 19.5.21

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0

## 19.5.20

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0

## 19.5.19

### Patch Changes

- Updated dependencies []:
  - @cogitator-ai/core@0.56.4

## 19.5.18

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3

## 19.5.17

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2

## 19.5.16

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/core@0.56.1

## 19.5.15

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/core@0.56.0

## 19.5.14

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/core@0.55.0

## 19.5.13

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/core@0.54.0

## 19.5.12

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/core@0.53.0

## 19.5.11

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/core@0.52.0

## 19.5.10

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/core@0.51.0

## 19.5.9

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/core@0.50.0

## 19.5.8

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/core@0.49.0

## 19.5.7

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/core@0.48.0

## 19.5.6

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/core@0.47.0

## 19.5.5

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0

## 19.5.4

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0

## 19.5.3

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0

## 19.5.2

### Patch Changes

- [#214](https://github.com/cogitator-ai/Cogitator-AI/pull/214) [`f903fc1`](https://github.com/cogitator-ai/Cogitator-AI/commit/f903fc15fca7e29f5187f1fc60e099a8a9b28a03) - Require `@modelcontextprotocol/sdk` 1.32.1 or later. Earlier versions did not tie experimental tasks to the session that created them, and their HTTP client transports and OAuth requests followed cross-origin redirects while re-sending custom headers and request bodies.

## 19.5.1

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0

## 19.5.0

### Minor Changes

- [#207](https://github.com/cogitator-ai/Cogitator-AI/pull/207) [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22) - Tools carry a `title`, an `outputSchema` and MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and they cross MCP in both directions. `getTools()` / `wrapMCPTools()` keep the server's title (or the title of its annotations), its hints and its output schema, as a zod schema of the result. `MCPServer` and `cogitatorToMCP()` advertise a tool's title, hints and `z.object()` output schema, and the server sends the result of such a tool as `structuredContent`, with its JSON as text for clients that read only `content`. A result the output schema rejects comes back as a tool error that says why. Only a `z.object()` output schema (`z.strictObject` and `z.looseObject` too) is advertised, since MCP output schemas need an object root and the MCP SDK takes them only as zod object schemas: a record, a union or a pipe is left out, and `MCPServer` warns when it registers such a tool. Nothing checks the output schema in a run.

  A tool the server marks destructive (`destructiveHint: true` without `readOnlyHint: true`) now needs approval: a Cogitator run pauses before it runs, and `invokeTool` asks `onApproval`. The new `requiresApproval` adapter option takes `true` (every tool), `false` (none) or a function of the MCP definition, and `isDestructiveMCPTool()` is the default check. A tool without the hint is not taken as destructive, although MCP's own default for a missing hint is `true`.

  `withParsedArguments(tool)` from core keeps a tool's approval, sandbox, timeout and result limit with a pass-through schema, for running through `invokeTool` a call whose arguments were already parsed with the tool's own schema. `MCPServer` uses it.

  **Migration:** agents whose MCP servers mark tools destructive now pause for approval before calling them. Approve them in your approval flow (`onApproval`, `cogitator.resume()`, the channels approvals), or pass `{ requiresApproval: false }` to `getTools()` / `wrapMCPTools()` for a server you trust (`requiresApproval: false` under `mcpServers.<name>` in a channels assistant config). Code that builds `MCPToolDefinition` objects by hand is unaffected, the new `title` and `outputSchema` fields are optional.

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0

## 19.4.0

### Minor Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - Tool results gain two parts and a size cap.

  `toolContent()` takes `{ type: 'json', value }` for structured data, which the application gets as it is and the model reads as JSON, and `{ type: 'resource', uri, name?, description?, mediaType?, text?, data? }` for a file, document or page. With `text` the model reads the contents under a line naming the resource, with base64 `data` it reads a description and the application keeps the bytes, with neither it reads the line alone, as a link. The MCP adapter serves them as JSON text and embedded resources, and a text resource that comes back from an MCP server with media keeps its URI.

  The model reads at most `limits.maxToolResultLength` characters of a tool result, 100 000 by default (about 25 000 tokens), and a tool's own `maxResultLength` overrides it. A longer result keeps its start and end, with a note in the middle of how much was left out, and errors are cut the same way. `onToolResult` still gets the whole result, while `RunResult.messages` and the thread history keep what the model read. The config schema and `COGITATOR_LIMITS_MAX_TOOL_RESULT_LENGTH` set the limit.

  `isToolContentResult`, `toolResultParts`, `toolPartsToText`, `truncateToolResultText` and `DEFAULT_TOOL_RESULT_MAX_LENGTH` now live in `@cogitator-ai/types`, so packages that do not depend on core read results the same way. Core re-exports them, imports from core keep working.

  **Migration:**

  - A tool result over 100 000 characters used to reach the model whole and now arrives cut, and so does the tool message in `RunResult.messages` and in the saved thread history. Checkpoints and learning traces built from those messages hold what the model read as well. Read whole results in `onToolResult`. Set `limits.maxToolResultLength`, or `maxResultLength` on the tool, to a larger number where a model really needs all of it. Both must be positive integers, anything else throws, in `tool()`, the `Cogitator` constructor and `ToolRegistry.register()` for tools built without `tool()` (in code, `Infinity` turns the cut off).
  - `toolPartsToMessageContent(parts, maxLength?)` cuts at 100 000 characters unless given another `maxLength`. The text parts of a result with images are cut as one text: start and end kept, parts in between left out.
  - `ToolContentPart` has two new members, so an exhaustive `switch` over `part.type` needs cases for `json` and `resource`.
  - A result from an MCP server that mixes media with a text resource now holds a `resource` part (with the URI) where it held a `text` part. Code that keeps only `text` parts should take `resource` parts too.

### Patch Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - Tool names are checked where a tool is created. `tool()` (and `fromAISDKTool()` of `@cogitator-ai/ai-sdk`) throws a `TypeError` for a name that one of the providers refuses, naming the rule (letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters, the strictest of OpenAI, Anthropic, Gemini and Bedrock) and a name that fits. Such a name used to fail only once a run sent it, as a 400 from the provider, or worked on one provider and broke on the next.

  `assertToolName(name)` throws the same error for tools built without `tool()`. `normalizeToolName(name)` turns any name into one that fits (`weather.get` becomes `weather_get`, a name too long is cut and ends with a hash of the whole one), `normalizeToolNames(names)` does the same for a set and keeps it distinct, `isProviderSafeToolName(name)` checks one, `TOOL_NAME_MAX_LENGTH` is 64. The MCP adapter uses them, `normalizeMCPToolName` gives the same names as before.

  `ToolRegistry.register()` and `registerMany()` warn when a different tool takes a name that is registered, since the model can only call one of them. `{ replace: true }` replaces on purpose without a warning. In a run, a tool of the agent still replaces a tool of the same name in `cogitator.tools` quietly.

  `A2AClient.asToolFromCard()` names the tool after the card in a form providers accept: `Research Agent` becomes `Research_Agent`. A handoff to an agent with a long name gets a `transfer_to_...` tool name cut to fit, with a hash, and handoffs to agents whose names come out the same (`Billing EU` and `Billing/EU`, names in other scripts) get a hash each, so the model can reach every one of them. Tools an agent writes for itself with `create_tool` are refused, and skipped when loaded, when their name breaks the rule.

  **Migration:** a tool whose name breaks the rule now throws when it is created. Rename it, or wrap a name built from data in `normalizeToolName()`. Names with dots or colons that only Gemini accepted are among them.

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0

## 19.3.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/core@0.40.0

## 19.3.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/types@0.41.1

## 19.3.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0

## 19.3.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0

## 19.3.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0

## 19.3.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0

## 19.3.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/types@0.37.0

## 19.3.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - MCP tool calls are no longer sent again after a timeout or a lost connection unless the tool is read-only or idempotent: the server may still be running the first call, so `callTool` throws `MCPToolInterruptedError` instead of deploying twice. Tool definitions keep their `annotations`, and tools from `getTools()` / `wrapMCPTools()` retry only when the server marks them `readOnlyHint` or `idempotentHint` (`callTool` takes `idempotent: true` for your own calls). Tool names are normalized to what every LLM provider accepts, with collisions kept apart by a hash (`normalizeMCPToolName`), so a server with `admin.list_users` no longer breaks every request. Input schemas keep their `$defs` and resolve `$ref`, recursive ones included, instead of showing the model `{}`. Images, audio and binary resources come through as `toolContent()` media in both directions instead of base64 text.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `MCPServer` and `SelfModifyingAgent` run tool calls through `cogitator.invokeTool()` instead of calling `execute` directly, so approval, the guardrails, the sandbox and `tool.timeout` apply as in an agent run.

  - `MCPServer` asks for a tool that needs approval through MCP elicitation, and refuses it with a clear `isError` result when the client cannot be asked. Before, `serveMCPTools([...builtinTools])` over HTTP ran `exec` on the host without anyone approving it. The new `toolInvoker` option takes your Cogitator so its sandbox manager and guardrails are used, and `serveAgents` uses its host for that. Arguments are still parsed exactly once.
  - `SelfModifyingAgent` takes `toolInvoker` and `onApproval`. A call nobody approves is refused and the model is told why, a sandboxed tool runs in the sandbox, and a tool whose parameters are a JSON schema (for example from `fromAISDKTool`) runs instead of failing the whole run with `safeParse is not a function`. `close()` releases the Cogitator the agent creates when no `toolInvoker` is given.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0

## 19.2.10

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 19.2.9

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 19.2.8

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 19.2.7

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/types@0.33.1

## 19.2.6

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 19.2.5

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 19.2.4

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 19.2.3

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 19.2.2

### Patch Changes

- 7e42e10: `MCPServer.registerTools` and `serveMCPTools` accept a `readonly Tool[]`, so frozen arrays, `as const` lists and toolsets typed as readonly can be served without copying.
- 7e42e10: `serveAgents` / `agentTools` added the `<agent>_resume` tool for any agent that had a tool with `requiresApproval` set, even `requiresApproval: false`. The resume tool is now added only when a tool can actually ask for approval (`requiresApproval: true` or a check function).
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0

## 19.2.1

### Patch Changes

- db8ebaf: Server handler types match what the server accepts: a resource's `read` may leave out `uri` (it defaults to the URI that was read) through `MCPResourceReadContent`, and a prompt's `get` may return plain string content through `MCPPromptReplyMessage`. The client's `MCPResourceContent` and `MCPPromptMessage` keep their complete shapes.
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 19.2.0

### Minor Changes

- 997e911: `serveAgents(cog, agents, config)` serves Cogitator agents as MCP tools in one call — stdio for Claude Desktop, Cursor and Claude Code, or HTTP with `auth` for remote, per-user use; `agentTools()` returns the same tools for your own `MCPServer`. Tools that need approval are asked from the person at the client through MCP elicitation (`MCPToolContext.elicit`); clients without it get a paused answer and an `<agent>_resume` tool. `MCPServer` gains `sessions: true` (a session per client over HTTP, which server-to-client requests need; a session belongs to the caller that started it).

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 19.1.0

### Minor Changes

- 8bdf656: `MCPServer` authenticates HTTP callers. The new `auth(request)` option returns the caller (`{ userId, scopes, metadata }`) or `undefined` to answer 401; the caller's `userId` reaches tools as `context.userId`, and resource `read` and prompt `get` handlers receive the caller as a second argument. `Authorization` is allowed in CORS requests. With an MCP client per user, connected with that user's token, one agent acts for each user on your own MCP server — see `examples/mcp/03-per-user-mcp.ts`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 19.0.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 19.0.0

### Major Changes

- @modelcontextprotocol/sdk 1.31.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 18.0.0

### Major Changes

- Resumed the unfinished 2026-07-26 audit at step 4. Main fixes: callTool now throws MCPToolError for isError results, where it used to return the error text as a success. Protocol errors and tool failures are no longer retried with backoff. Concurrent calls share one reconnect, the abort signal and timeout are passed through, and close() always closes the transport, so stdio children no longer leak. jsonSchemaToZod no longer drops arguments for object schemas without properties, and now handles type arrays, nullable, const and additionalProperties; an invalid regex pattern no longer breaks getTools. On the server: the tool's full Zod schema goes to the SDK (no double transforms or lost modifiers), image/audio/resource content passes through, prompts and resources propagate errors as JSON-RPC errors, prompts without arguments work, logging goes to stderr so it no longer corrupts stdio JSON-RPC, start() rejects on EADDRINUSE instead of hanging, stop() closes keep-alive connections, and getPort() was added. New tests use the real SDK over HTTP instead of mocks.

  **Breaking changes**
  - MCPClient.callTool throws MCPToolError when the server returns isError: true (previously returned the error text)
  - callTool returns structuredContent when present and null for empty results (previously the raw protocol envelope)
  - mcpContentToResult unwraps a single non-text block instead of returning a one-element array
  - MCPServer resource read / prompt get handler errors are now JSON-RPC errors instead of fake 'Error: ...' content/messages
  - MCPServer logging writes to stderr instead of stdout

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 17.0.11

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 17.0.10

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 17.0.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 17.0.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 17.0.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 17.0.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 17.0.5

### Patch Changes

- fix(mcp): audit — 6 bugs fixed, +28 tests, v17.0.5
  - Fix missing exports: toolSchemaToMCP, mcpContentToResult, resultToMCPContent, serveMCPTools, StdioTransportConfig, HttpTransportConfig
  - Fix createHttpTransport ignoring headers config
  - Fix timeout timer leak on successful connection
  - Fix unregister methods silently failing after server start (now throws)
  - Move @types/node to devDependencies
  - Add 28 new tests (88 total)

## 17.0.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 17.0.2

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 17.0.1

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 17.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 16.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 14.1.0

### Minor Changes

- feat(mcp): add server-side resources and prompts support

  Add full MCP specification compliance for MCPServer with:
  - registerResource() for static and dynamic (templated) resources
  - registerPrompt() for reusable prompt templates with arguments
  - Support for URI templates like 'memory://thread/{id}'
  - Batch registration methods: registerResources(), registerPrompts()
  - Getter methods: getRegisteredResources(), getRegisteredPrompts()
  - Unregister methods: unregisterResource(), unregisterPrompt()

## 14.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 13.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 10.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 9.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 8.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 8.1.0

### Minor Changes

- DX Improvements - Phases 1-3

  Phase 1: Foundation
  - Added comprehensive JSDoc documentation to core public APIs
  - Extended config schema with memory, sandbox, reflection, guardrails, costRouting, logging

  Phase 2: Critical Fixes
  - ThreadManager: Added persistent storage with InMemoryThreadStorage, RedisThreadStorage, PostgresThreadStorage
  - SSE Streaming: EventEmitter-based real-time streaming for openai-compat
  - MCP Retry: Exponential backoff with auto-reconnect and connection recovery

  Phase 3: Polish
  - New examples: memory-persistence, openai-compat-server, mcp-integration, constitutional-guardrails

## 8.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 7.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 6.0.1

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 6.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 5.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 4.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 3.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 2.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 1.1.0

### Minor Changes

- Add MCPClient tests (connect, capabilities, tools, resources, prompts)
- Add MCPServer tests (register, start/stop, logging)
- Add HTTP server shutdown support in stop() method
- Remove redundant type casts in MCPServer

## 1.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
