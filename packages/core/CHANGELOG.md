# @cogitator-ai/core

## 0.66.0

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
  - @cogitator-ai/memory@0.26.5
  - @cogitator-ai/sandbox@0.8.6

## 0.65.0

### Minor Changes

- [#294](https://github.com/cogitator-ai/Cogitator-AI/pull/294) [`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941) - Run safe tool calls together and keep writes of one file apart, give the application a richer tool result than the model reads, see tool calls while the model writes them, and give each stage of a run its own deadline.

  Breaking:

  - `parallelToolCalls: true` no longer runs every call of a step at once with `Promise.all`. Only calls that are concurrency-safe run together, in a pool of `maxParallelToolCalls` (10 by default), and a call that is not safe waits for every call before it, runs alone, then the rest go on. A tool that declares nothing is not safe, so a step of such tools now runs one call after another. To keep calls running side by side, mark their tools `isConcurrencySafe: true`, or `annotations: { readOnlyHint: true }` as MCP describes a read-only tool. Without `parallelToolCalls` nothing changes: every call runs after the one before it.
  - A Docker-sandboxed call that runs out of time now fails with `errorCode: 'TOOL_TIMEOUT'` and the error `Tool "<name>" timed out in the Docker sandbox after <n>ms`, as a WASM one already did, instead of returning `{ stdout, stderr, exitCode, timedOut: true, ... }` as its result. Code that read `result.timedOut` checks `errorCode === 'TOOL_TIMEOUT'` instead.

  New:

  - `tool({ isConcurrencySafe })` takes `true`, `false` or a check of the call's arguments (one that throws says no), and defaults to `annotations.readOnlyHint`, so MCP tools a server marks read-only are safe. Results reach the model in call order however the calls ran. After a call that asks a question (`context.interrupt()`) no further call of the step starts, the others run once the answer came. An abort answers the calls it kept from starting with `Aborted before dispatch`, and steering messages land after the whole step. A call scheduled as safe is checked again with the arguments a `wrapToolCall` middleware left: when they are not safe, it waits for the running calls of the step and runs alone, the calls after it wait (`StepGate`). A paused run keeps `parallelToolCalls`, `maxParallelToolCalls` and its own `timeouts` in `checkpoint.toolExecution` (optional, the checkpoint stays `version: 1`), and `resume()` reuses them unless its options set them, a kept `timeouts.totalMs` arming the deadline again unless the resume passes `timeouts.totalMs` or `timeout`.
  - `tool({ lockKeys: (args, context) => keys })` names what a call changes. Calls whose keys meet never run at the same time, in this run or any other run of the process, and go one after another in the order they asked, without ever waiting on each other. A safe tool with lock keys writes different files together and one file in order. `fileLockKey(path)` is `file:` and the file's real path, symlinks followed, also for a file not created yet. A lock key function that throws fails its call with `Could not tell what the call changes`, and a call whose run aborts while it waits gives up its place. Keys are let go only once the tool's own promise settles, also after `TOOL_TIMEOUT` or an abort: the run gets the timeout at once, the file stays locked until the tool really stops. Keys are re-entrant along the call lineage, so a nested run or `invokeTool()` started from a tool takes a key that tool holds without waiting. Time waiting for a key or for the step does not count toward `toolMs` or the tool's `timeout`, the run's `totalMs` still runs.
  - Built-in tools say how they run: `read_file`, `list_files`, `glob` and `grep` of `workspaceTools()` and `file_read`, `file_list` and `file_exists` are concurrency-safe, `write_file`, `edit_file`, `file_write` and `file_delete` lock the real path of the file they change. An absolute path inside the workspace root gets the same key as the relative one. `restrictFileTools()` keeps these fields, the lock keys getting the path it resolved.
  - `toolOutput({ content, details?, presentation? })` splits a result by reader: the model reads `content` (any JSON value or a `toolContent()` result), `onToolResult` gets `details` and `presentation` too (`ToolResult.details`, `ToolResult.presentation`), and memory keeps them in the metadata of the call's `tool_result` entry (`metadata.details`, `metadata.presentation`) while its `toolResults` keep only what the model read. `cog.invokeTool()` splits the result the same way, and so do the boundaries outside a run: `toAISDKTool()` of `@cogitator-ai/ai-sdk` without an invoker returns the whole `toolOutput()` result to the AI SDK application while its `toModelOutput` (`experimental_toToolResultContent` on ai@4) gives the model only `content`, and the OpenAI and Gemini realtime sessions of `@cogitator-ai/voice` send the model only `content` of a `RealtimeTool` that returns one. `toolOutputContent(value)` reads what a model sees of any result.
  - `tool({ presentation })` tells a client how to show a call without the tool's code, `{ label, icon?, detail? }` or a function of the arguments, used when the result carries none, failed calls too. The workspace tools present themselves as Read file, Write file, Edit file, List files, Find files, Search files and Run command, with the path, pattern or command as the detail.
  - `context.update({ content?, details?, presentation? })` reports what a running tool has so far: `onToolUpdate` of the run (with `callId` and `name`) and `onUpdate` of `invokeTool()` get it, nothing of it reaches the model or memory, and an update after the tool returned or after its run was aborted is dropped. Two calls that hold keys and, through tools they run, wait for each other's fail fast: the call that would close the circle gets `errorCode: 'TOOL_LOCK_CYCLE'` (new `ErrorCode.TOOL_LOCK_CYCLE`, 409, `LockCycleError` and `LockOwner` exported from core). A call's arguments are read by its schema once, for the safety check, the lock keys, the presentation and the tool, which all get the value the schema made, typed as its output (`ToolCallCheck<TParams>`, `ToolPresenter<TParams>`). A key is taken again without waiting only while the call that holds it still does, and a call aborted while it works out its keys never runs. A tool's `outputSchema` describes the `content` of a `toolOutput()` result (`ToolOutputContent<TResult>`), so an MCP server checks and sends `content` as `structuredContent`, while `execute` keeps the type it returns. The schema no longer widens the result type `execute` returns: a tool whose schema is wider than what its `execute` is inferred to return (a `z.record()` schema for an object literal) annotates the return type of `execute`.
  - Tool calls stream while the model writes them. The OpenAI-compatible backends (Azure OpenAI, OpenRouter and other servers through them), OpenAI Responses, Anthropic and Bedrock stream a call's id and name, then the pieces of its JSON arguments, in `ChatStreamChunk.delta.toolInput`, and an `end` part once the call is complete: Anthropic at `content_block_stop`, Responses at `function_call_arguments.done`, Bedrock at `contentBlockStop`, OpenAI-compatible servers when the next call starts and the previous one's arguments already read as a complete JSON object, else at a finish that may run tools (not at the token limit), so a call whose pieces a server mixes with another's loses none of them. The OpenAI-compatible backends keep the first non-empty id and name of a call. Gemini and Ollama get whole calls, each reported at once when it arrives. Streamed runs report them to `onToolInputStart`, `onToolInputDelta`, `onToolInputAvailable` and `onToolInputAbandoned`, and to the tool's own `onInputStart`, `onInputDelta`, `onInputAvailable` and `onInputAbandoned` hooks, named as in the AI SDK. Available fires as soon as a call is complete, and a call that never had argument text (an empty Anthropic input) gets its arguments as one delta, `{}`, before it. Every call `onToolInputStart` reported ends in `onToolCall` or in abandoned, with `reason: 'incomplete'` when its arguments never came complete (a turn cut at the token limit, failed or aborted) or `'discarded'` when the turn kept no such call (an `afterModel` middleware dropped it or gave it another tool, a turn that may not call tools, a turn cut at the token limit after the call was complete). Callbacks and hooks that throw are logged, the turn goes on. The hooks are read for each model turn, so after a handoff the tools of the new agent get them. A run whose middleware holds the stream (output guardrails) gets no input events, and a run streamed only for tool input keeps structured output repair, which is skipped only when text streamed to `onToken` or `onReasoning`.
  - `timeouts: { totalMs, stepMs, chunkMs, toolMs }` on `RunOptions` and `AgentConfig`, the run's fields over the agent's field by field, all off unless set. `totalMs` bounds the whole run (`RUN_TIMEOUT`, over `timeout`), `stepMs` one model call with its retries and fallback models (the new `RUN_STEP_TIMEOUT`, 504), `chunkMs` a streamed call without a chunk for that long (the new `RUN_CHUNK_TIMEOUT`, 504, not retried), and `toolMs` the calls of tools without a `timeout` of their own: such a call fails with `Tool "<name>" timed out after <n>ms` and `errorCode: 'TOOL_TIMEOUT'`, the model reads why and the run goes on. `ToolResult.errorCode` is new, and spans record it as `error.type`. The agent's `timeouts` travel in `serialize()` and the agent wire format. Unlike `llm.retry.requestTimeout`, which retries one attempt, a stage timeout ends the run.
  - `@cogitator-ai/core` exports `toolOutput`, `isToolOutputResult`, `isConcurrencySafe`, `scheduleToolCalls`, `DEFAULT_MAX_PARALLEL_TOOL_CALLS`, `KeyedLock`, `StepGate`, `toolLocks`, `fileLockKey` and `toolOutputContent`. `@cogitator-ai/types` adds `ToolOutputResult`, `ToolPresentation`, `ToolProgress`, `ToolUpdate`, `ToolInputStart`, `ToolInputDelta`, `ToolInputAvailable`, `ToolInputAbandoned`, `ToolInputStreamPart` (with `start`, `delta` and `end` parts), `RunCheckpoint.toolExecution`, `RunTimeouts`, `isToolOutputResult()` and `toolOutputContent()`.
  - The streaming protocol of the server adapters gets a `tool-update` event (`toolCallId`, `content?`, `details?`, `presentation?`) between a call's `tool-call-end` and its `tool-result`, and `tool-result` carries `details` and `presentation`. In a streamed run `tool-call-start`, `tool-call-delta` and `tool-call-end` now follow the model as it writes the call, the end coming as soon as the call is complete so calls do not interleave unless the provider mixes their pieces, and a run whose stream is held back sends the three at once right before the call runs, as before. A call that will never run gets a `tool-result` with the new `dropped: true` and `reason` (`'incomplete'` or `'discarded'`), after a `tool-call-end` with the new `dropped: true` when its end had not gone out, and the stream session drops, when it completes or fails, every call it announced that never came to run (calls that run or wait for approval are kept). A dropped call a middleware then gives another tool under the same id is announced again with a new `tool-call-start`, and a streamed call that runs with other arguments (an `afterModel` middleware changed them under the same id and name) gets a `tool-update` with the new `arguments` right after its end, which `useCogitatorChat` puts in place of the streamed ones before it reports the call to `onToolCall` again. A client that does not know `dropped` sees such a call as a call with an empty result. `@cogitator-ai/server-shared` adds `createToolUpdateEvent()`, `createToolDroppedEvent()`, the `dropped` argument of `createToolCallEndEvent()`, `ToolUpdateEvent`, `ToolUpdateEventSchema`, `ToolPresentationSchema` and the `dropped` and `reason` fields of `ToolCallEndEventSchema` and `ToolResultEventSchema`, and the OpenAPI document lists them. The Next.js and Tetsu stream handlers pass the new callbacks through, `onToolInputAbandoned` included. `useCogitatorChat` of `@cogitator-ai/next` never adds a dropped call to a message, removes a call whose result says `dropped` and calls the new `onToolCallDropped(toolCallId)` (`onToolCall` may have reported it before), and its `onToolResult` carries `details` and `presentation`.
  - `MockLLMBackend` of `@cogitator-ai/test-utils` takes `toolInput` in its stream chunks, so custom code that reads tool input is testable without a model.
  - Cogitator Studio shows a tool call by its presentation label and detail, its latest progress while it runs, and its details in a block of their own.

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0
  - @cogitator-ai/memory@0.26.4
  - @cogitator-ai/sandbox@0.8.5

## 0.64.0

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
  - @cogitator-ai/memory@0.26.3
  - @cogitator-ai/sandbox@0.8.4

## 0.63.1

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/memory@0.26.2
  - @cogitator-ai/sandbox@0.8.3

## 0.63.0

### Minor Changes

- [#289](https://github.com/cogitator-ai/Cogitator-AI/pull/289) [`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd) - Agent Skills from `SKILL.md` folders, todo lists with `write_todos`, and deferred tools found with `tool_search`.

  - `SkillRegistry` (core) finds skills in the Agent Skills format: folders with a `SKILL.md` whose YAML frontmatter gives `name` and `description`, next to the files the skill needs. It searches `dirs` (folders of skills, or a skill folder itself), a `project` folder on the host, with `user` the home folder, and the run's workspace (`.agents/skills`, `.cogitator/skills` and `.claude/skills` under its root, unless `workspace: false`), the first skill of a name winning. Host folders win over the workspace by default, so a skill a repository or the agent put there cannot replace one you chose, and `precedence: 'workspace'` puts the workspace first. Frontmatter is read leniently: a file without frontmatter or `description` is skipped, a name that breaks the format's rules or differs from its folder, a value of the wrong type or past its length and an unknown YAML tag are loaded with a warning, and every problem is in the catalog's `diagnostics` and logged once. Only metadata is kept (`name`, `description`, `license`, `compatibility`, `metadata`, `allowedTools`, `location`, `source`), the body and the files are read when the skill is activated. Host folders are scanned once per registry (`reload()` scans again), the workspace on every run, abortable with the run.
  - `AgentConfig.skills` takes a `SkillRegistry`, its configuration or any `SkillLoader` next to skills defined in code, whose tools and instructions still join the agent's. When skills are found, the system prompt ends with an `<available_skills>` section (names and descriptions, at most 12 000 characters of descriptions, then names only) and the run offers `use_skill({ skill })`, which returns the body of `SKILL.md` without its frontmatter (cut at `maxInstructionChars`, 20 000 by default, with a note where the rest is), the skill folder and its files. Files of a skill in the workspace are read with the agent's `read_file`, files of a host skill with `read_skill_file({ skill, path })`, which refuses paths that leave the skill folder, symlinks included. In the workspace a symbolic link is never followed, for a skill folder, the folders above it, its `SKILL.md` or its files, checked on every read. Activating a skill whose instructions are still in the conversation returns a short note, told apart by the skill's folder and workspace, so another agent's skill of the same name loads its own. An agent a handoff reaches gets its own skills. `allowed-tools` is kept on the skill and named to the model, not enforced. An invalid skills source fails the run with `CONFIGURATION_ERROR`, and an object that looks like a code skill but is not one is refused by the `Agent` constructor.
  - `AgentConfig.todos` gives the model `write_todos({ todos: [{ id, content, status }] })`. Each call replaces the list, ids are unique and at most one item is `in_progress`, else the call fails with a validation error. The list is read from the conversation and copied to the thread's metadata under `todos` (`{ items, entryId }`) by a run that saves to memory on the active branch. A later run whose history lost the list gets it from there when `entryId` is on its branch. The list is reported with the new `RunOptions.onTodos` and `RunObserver.onTodos` (also when a run starts from one), whose errors and failed metadata writes are logged without undoing the list, and returned as `RunResult.todos`. `todos` travels in the agent wire format and in snapshots.
  - `Tool.deferred` keeps a tool's schema out of the requests. A run whose agent has deferred tools offers `tool_search({ query, limit })`, which ranks them with BM25 over names, descriptions and parameter names and descriptions, identifiers split into words, and loads the best ones: their schemas are sent from the next turn on. The loaded tools are read back from the `tool_search` results in the conversation, so they stay loaded after a resume, in a fork, after a handoff and in later runs of the thread. A call to a deferred tool that was not loaded still runs, and a deferred tool forced with `toolChoice` is sent and stays loaded. The history budget counts the tools loaded in a `history` the run is given, and a history whose loaded tools push it past the window is cut to fit. Loading tools changes the tool list, and so the prompt cache prefix from that turn.
  - Clearing tool outputs leaves the run's own `use_skill` (the newest, up to 40 000 characters), `tool_search` and `write_todos` results alone, a tool of yours with one of these names is cleared as before. Compaction of a run's conversation puts the instructions of active skills (the newest, up to 40 000 characters, a note naming the rest) and the tools a search loaded back as system messages when it dropped them, and the newest todo list as a `write_todos` call and its result that checkpoints and `history` keep, one each however many compactions there are, and keeps room for them in the window. `ContextManager.compress()` takes the tokens to keep free, and `ToolRegistry.getSchemas()` a filter.
  - `Agent.clone()` merges the instructions of skills defined in code once, also clone after clone, where each clone used to add another copy.
  - Cogitator Studio shows a run's todo list in a Todos panel, updated live from the new `run.todos` host event, and keeps it in `RunRecord.todos`.
  - The `SkillLoader` interface of types, declared but never implemented, now describes a source of `SKILL.md` skills (`discover(context)` returning a `SkillCatalog`, `context.signal` aborting with the run), and `AgentConfig.skills` is typed `AgentSkillSource[]`.

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/memory@0.26.1
  - @cogitator-ai/sandbox@0.8.2

## 0.62.0

### Minor Changes

- [#288](https://github.com/cogitator-ai/Cogitator-AI/pull/288) [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b) - Memory defaults chosen on the memory benchmarks, and a shadow mode for extraction.

  - Behavior change: `memory.contextBuilder` without a `strategy` now uses `hybrid` when `memory.embedding` is set, and `recent` otherwise as before. A runtime with embeddings and no strategy keeps the newest turns as history and also recalls the earlier turns and memory items that match the turn, which embeds every message of a thread once, in the background. On seven long-memory datasets `hybrid` averaged 44.9% against 18.0% for `recent`, as much as `relevant` at three quarters of its cost. A `strategy` you set is kept, so set `strategy: 'recent'` to keep the old behavior.
  - `memory.extraction.mode` (types, core, config): `apply` by default, or `shadow`, which writes every new item as `suggested`, so it reaches no context, no recall and no fact until it is reviewed (`MemoryItems.query` with `statuses: ['suggested']`) and activated (`MemoryItems.activate`). It is `MemoryItems({ shadow: true })` (memory), which also leaves the confidence of other opinions alone. Extraction stays off by default and the docs recommend starting with `shadow`. Compaction stays off by default too.
  - Scaffolded projects with a lasting store (`sqlite`, `postgres`, `redis`, `mongodb`) get long-term memory in `cogitator.yml`: the provider's embedding model in `memory.embedding` with the `hybrid` strategy (`recent` with Anthropic, which has no embedding model), and `memory.files` for the agents' notes. On Ollama the embedding model is pulled with the chat model. The `assistant` preset is among them. Only Postgres keeps the vectors: on SQLite, Redis and MongoDB the message index lives in the process, so after a restart (`cogitator dev` restarts on every change) each thread's messages are embedded again the first time it is used, one embedding per message. That cost is cents beside the gain of `hybrid`, so those templates keep it, and the generated AGENTS.md says so.

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/sandbox@0.8.1

## 0.61.1

### Patch Changes

- [#286](https://github.com/cogitator-ai/Cogitator-AI/pull/286) [`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2) - Remote workspaces: an agent's whole workspace, files and commands, in a cloud sandbox on E2B, Daytona or Vercel Sandbox, with the same behavior on every provider.

  - `E2BWorkspace`, `DaytonaWorkspace` and `VercelSandboxWorkspace` (sandbox) create their sandbox on first use, or reuse one by `sandboxId`, `sandbox` (id or name) or `name`, and release it in `dispose()` as `onDispose` says: `destroy`, `stop` (Daytona, Vercel) or `keep`. Their SDKs (`e2b` 2.28.1 or later, `@daytona/sdk`, `@vercel/sandbox`) are optional peer dependencies loaded on first use. Without the SDK, without credentials (`E2B_API_KEY`, `DAYTONA_API_KEY`, Vercel's OIDC token found by its SDK, or `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`) or when the sandbox cannot be created, the first operation fails with a `WorkspaceError` of code `UNAVAILABLE` that says which, and an SDK that fails to load for another reason is reported with that reason. E2B and Vercel sandboxes get a `lifetime` (30 minutes) that the workspace pushes back while it is used. A Vercel sandbox created without a name is not persistent, `destroy` deletes the snapshots only it used, and `image` picks its image. Daytona commands get their `env` from a short-lived file of a private directory, so the values stay out of the command line Daytona records.
  - `RemoteShellWorkspace` (sandbox) is what they share, over a small `RemoteShellDriver` (connect, read and write bytes, run a program, start one with streamed output and stdin, release), so another provider is one driver away. Everything else runs as shell scripts in the sandbox: paths normalized against the root and resolved with `realpath -m`, so a symlink out of the root is refused with `OUTSIDE_ROOT`, also by the workspace's own directories, reads that copy at most one byte over `maxFileBytes` to a private file of the sandbox's temporary directory before they download (reads never write the root), atomic writes that keep the file's mode (uploads go through the temporary directory, and `.cogitator/snapshots` is checked to be a real directory of the root every time a script uses it), listings sorted like `LocalWorkspace` with `includeHidden`, `skipDirs`, `glob` and `limit` (sorted, cut and narrowed in the sandbox, 64 MiB at most), the trash in `.cogitator/trash`, the `rename` rules for `overwrite`, and `BUSY` while a command runs or kept background processes. Commands run under `setsid` in their own process group, reported with marker lines whose token comes on stdin: a timeout returns exit code 124 and kills the group, an abort rejects with `ABORTED`, `background: 'keep'` leaves background processes until `dispose()`, and output past `maxStreamBytes` (64 MiB) stops the command, since the SDKs keep whole outputs in memory. A group is only signalled while it still leads the session its command started.
  - Remote workspaces implement snapshots: `snapshot({ label, metadata, exclude })`, `restore(id)`, `listSnapshots()` and `deleteSnapshot(id)` keep tar archives in `.cogitator/snapshots` inside the sandbox, always without `.cogitator/**`, names that are not UTF-8 kept as they are and `maxSnapshotBytes` (1 GiB) as the cap, and a restore removes what was made since and leaves the excluded paths alone.
  - `shellQuote` and `shellCommand` (sandbox) build a shell line that passes every argument as it is, quotes, newlines, globs and leading dashes included.
  - `workspaceGlobMatcher` (types) is the glob matcher of `WorkspaceListOptions.glob`, now shared by every workspace. `LocalWorkspace` and `workspaceTools` (core) use it, with no change in what they match.

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/sandbox@0.8.0
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/memory@0.25.6

## 0.61.0

### Minor Changes

- [#284](https://github.com/cogitator-ai/Cogitator-AI/pull/284) [`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83) - Workspaces: one directory an agent works in, with file access and commands that cannot leave it, locally or in a Docker container, and long tool results saved there instead of lost.

  - `Workspace` (types) is the interface: `id`, `root` and `cwd`, `withCwd(cwd)` for a view with another current directory, `read`, `readBytes` and `write` with size limits, `list({ recursive, glob })`, `stat`, `exists`, `mkdir`, `rename`, `remove({ recursive, trash })`, `exec(command, { cwd, env, timeout, signal, onStdout, onStderr })`, `contains`, `start` and `dispose`, and optional `snapshot`, `restore`, `listSnapshots` and `deleteSnapshot` (snapshots leave `.cogitator/**` out by default, see `WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE`). Paths are relative to the root, and a path that resolves outside it (`..`, an absolute path elsewhere, a symlink out, also a dangling one or one a command created) fails with a `WorkspaceError` of code `OUTSIDE_ROOT`. Every failure is a `WorkspaceError` with a typed `code`, `DENIED` for what the system or a policy refuses. Workspaces start themselves on first use, `start()` is optional, `dispose()` is the owner's.
  - `LocalWorkspace` (core) works in a directory of this machine. Only regular files are read and written (a FIFO or a device is refused before it is opened, files open with `O_NONBLOCK` and `O_NOFOLLOW` and are checked again once open). Writes are atomic and flushed: a temporary file in the same directory is renamed over the target, keeping its mode, so a crash never leaves half a file (see the sweep below) and a hard link to a file outside the root is replaced, not written through. A read-only file is refused (code `DENIED`) unless `force` is passed. `remove` and `rename` move the entry into `.cogitator/pending/` and check it is the one they resolved, and an entry only ever takes a name nothing else holds (a fresh random name in the verified directory, then a hard link or a rename onto nothing), so a directory swapped for a symlink cannot make them delete, replace, pull in or push out anything outside the root. An entry pulled in by such a swap is never moved to a path resolved anew: it stays quarantined in `.cogitator/pending/`, named in the error and logged, never deleted. `remove` and `rename` refuse with the new code `BUSY` while a command the workspace started is still running or left processes behind. Leftover temporary write files are swept on start once untouched for `leftoverAge`, and entries an interrupted move left are recovered into `.cogitator/pending/recovered-*`, never deleted. `.cogitator` and `.cogitator/pending` are off limits to the workspace's own operations, and errors no longer carry host paths. `refuseHardLinks` refuses to read hard-linked files (off by default, pnpm stores hard-link `node_modules`). `remove(path, { trash: true })` moves entries to `.cogitator/trash/<time>/`, and `.cogitator/` gets a `.gitignore` with `*`.
  - `LocalWorkspace.exec` runs each command in a process group of its own with only the environment a shell needs (no API keys, `HOME` included), streams and caps its output, and on a timeout or an abort sends SIGTERM to the group and SIGKILL after `exec.killGrace`, also to background processes the shell left behind. A call returns when the command exits, also when a background process still holds its output: `background: 'kill'` (default) stops the rest of the group then, `'keep'` leaves it running until `dispose()`, which kills every group the workspace started that still has processes. `exec.launch` changes what is spawned, for OS sandboxes such as `sandbox-exec` or `bwrap`. On Windows commands run with `cmd.exe /d /s /c` and only the command itself is killed.
  - `DockerWorkspace` (sandbox) runs the commands of a host workspace in one long-lived container with an init process, created on first use and removed in `dispose()` (which also disposes the host), the host root bind-mounted at `/workspace`, files read and written through the host workspace and its guard, `remove` and `rename` done in the container where no symlink reaches the host, and paths under `/workspace` mapped to the root. Each command leads its own process group, reported by a marker line taken out of stderr wherever it appears (its token comes on stdin, out of the command's reach), and signalled with the container's `kill` on a timeout or an abort, so background and `env -i` processes go too, and the call returns at most `killGrace` plus a second later. `background` works as for `LocalWorkspace`, and an abort while the command is starting is honored. Starting removes containers of the same root left by a gone process of this machine, matched by host name, boot and PID namespace. Defaults are 2 GB, 2 CPUs and 512 processes, Docker API failures come as code `IO`, no Docker as `UNAVAILABLE`.
  - `createSandboxContainer` (sandbox) is the container setup the pool and `DockerWorkspace` share. The pool's containers are created as before.
  - `AgentConfig.workspace` and `RunOptions.workspace` (the run's wins) reach tools as `context.workspace` and middleware as `RunMiddlewareContext.workspace`. A handoff target brings its own, an agent called with `agentAsTool` gets the caller's unless it has one, `invokeTool` takes `workspace`, and `resume()` takes it again like `deps`.
  - `workspaceTools(workspace?, options?)` (core) gives an agent `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep` and `run_command` (with `background` to keep what it starts with `&`), named apart from the global `file_read`, `file_write` and `exec` built-in tools so both sets fit in one agent. `read_file` pages by line (`offset`, `limit`) and, inside a line too long for one page, by `column`, and reports CRLF endings. `edit_file` refuses binary and non-UTF-8 files and keeps CRLF endings when the strings use plain newlines. `grep` matches whole lines in a worker thread with `grepTimeout` per file, so a pattern such as `(a+)+$` fails instead of blocking every run, takes `includeHidden`, and searches what it listed when the listing hits its limit (`incomplete`). Only `run_command` asks for approval by default.
  - A tool result longer than the model may read is saved in full to `.cogitator/tool-results/<runId>/<toolCallId>.txt` in the workspace the agent's `read_file` reads (its bound workspace, else the run's), and the model gets the cut preview with the path and how to page through it. Saved results of runs older than `limits.toolResultRetention` (7 days by default) are removed when a new one is saved, and ids that are not safe file names get a short hash so two never share a file. Without one, with a `read_file` of another origin, or when saving fails (logged), the result is only cut, as before. `toolResultPath()` gives the path.
  - The assistant preset of `create-cogitator-app` builds its workspace tools on `LocalWorkspace` and `workspaceTools`. Its tools are renamed: `file_read` is now `read_file`, `file_list` is `list_files`, `file_write` is `write_file`, and `edit_file`, `glob` and `grep` are new. `file_exists` and `file_delete` are gone, the assistant no longer deletes files. `write_file` and `edit_file` still need approval.

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/sandbox@0.7.0
  - @cogitator-ai/memory@0.25.5

## 0.60.3

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/sandbox@0.6.25

## 0.60.2

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/sandbox@0.6.24

## 0.60.1

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/sandbox@0.6.23

## 0.60.0

### Minor Changes

- [#272](https://github.com/cogitator-ai/Cogitator-AI/pull/272) [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899) - Channels: the gateway answers the messages of a thread one at a time and keys threads by conversation.

  This changes behavior for existing gateways:

  - `queueMode` defaults to `'sequential'`: a thread answers its messages in the order they came, one at a time, while different threads run side by side. A channel's message handler returns once the message is queued, so Telegram long polling and the Bluesky and Threads polls go on to other chats, button presses and stop buttons while a thread is busy. `injectMessage` resolves once the message is answered, and the new `gateway.idle()` waits until every queued message is.
  - Channels now confirm a message to their platform once it is queued, before it is answered: Telegram long polling moves its offset, Bluesky marks its notifications seen, Threads moves past the post. So `gateway.stop()` drains first: it flushes the debouncer and waits up to the new `drainTimeout` (default 30000 ms) for the queued messages and the runs in progress, then aborts the runs still going, drops what still waits, waits up to `drainTimeout` again for the aborted runs to settle and only then stops the channels. Messages that come in while it stops are dropped and reported to `onError`, a second `stop()` returns the same promise, and `RuntimeBuilder`'s `cleanup()` closes memory after it. `cogitator assistant` and `cogitator up` wait for it, quitting at once on a second Ctrl-C.
  - `injectMessage` rejects when the message was not answered: its run failed (also reported to `onError`, as before), `stop()` aborted or dropped it, or it came in while the gateway was stopping. `HeartbeatScheduler` records that as an error, and a one-shot task that fails stays pending and fires again on a later poll or after a restart (up to `maxRetries`, unless it is `bestEffort`) instead of being lost.
  - The default thread key is `channelType:conversation:userId` instead of `channelType:userId`. The conversation is the new `ChannelMessage.conversationId` when a channel sets it, else `channelId` plus `:topicId`. A user's private chat, each group, each Telegram forum topic, each Slack thread and each GitHub issue, pull request and review thread is a thread of its own.
  - Slack sets `topicId` to the `ts` of the Slack thread of a channel message. A top-level channel message is answered in a new Slack thread, a conversation of its own without the history of earlier ones, and `sendText` posts into the `topicId` thread when a reply names no message. A DM stays one conversation.
  - Bluesky and Threads set `conversationId` to `thread:<root>`, so the replies of one post thread stay in one thread while each answer still goes to its post. A WhatsApp direct chat addressed by LID sets `conversationId` to the person's phone-number jid when WhatsApp shares it, so it is one thread with the chat addressed by phone number. `userId` stays as before. `ChannelAction` and `ChannelStop` carry `conversationId` too, and the approval buttons check it.
  - Telegram gives a button press a `topicId` only in a forum topic or a private chat topic, as it does for messages, so Approve and Deny work in the reply threads of plain groups.
  - Runs get the `topicId` and `conversationId` of their message (`RunOptions`, `ToolContext`, the run middleware context and `invokeTool` options have both, and `@cogitator-ai/ai-sdk` passes them between the AI SDK and Cogitator tool contexts like the other channel fields, while workflows and swarms build no channel context), `schedule_task` stores them with the task and `HeartbeatScheduler` puts them on the message it fires, so a reminder set in a topic or a post thread fires there, even after the user moved on. A task without them is answered in the topic of the user's most recent conversation in its chat, taken from the conversations the gateway keeps in each user's session metadata (`conversations`, up to 50). `compactAll()` finds the threads of stored sessions there after a restart.
  - `stats.totalSessions` and `getSessions()` count conversations, not users, and the gateway keeps its bookkeeping of the 10000 most recent threads (`MAX_TRACKED_THREADS`).
  - New exports: `defaultThreadKey`, `legacyThreadKey`, `conversationOf`, `readConversations`, `CONVERSATIONS_KEY`, `MAX_TRACKED_THREADS` and the types `ConversationRef`, `StoredConversation` and `MessageProcessor`. `MessageQueue.push` returns a promise that settles once the message is done with, `true` when it was handled, and its processor may resolve `false` for a message it could not handle (`MessageProcessor`).

  Migration: to keep the old behavior, pass `queueMode: 'parallel'`, and pass `session: { threadKey: legacyThreadKey }` to keep the threads stored under the old key (their history is not found by the new one). With `legacyThreadKey`, `compactAll()` still finds the thread of every stored session, while any other custom `threadKey` leaves stored sessions to it and the gateway keeps no conversations. With `cogitator up`, set `session.queueMode: parallel` and `session.threadKey: legacy` in `cogitator.yml`.

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/sandbox@0.6.22

## 0.59.0

### Minor Changes

- [#269](https://github.com/cogitator-ai/Cogitator-AI/pull/269) [`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698) - Voice replies are spoken while the model generates them, and an interrupted reply leaves only what the user heard in memory

  `VoiceAgentRunner` gains an optional `stream(input, context)` that returns a `VoiceTurn`: an `AsyncIterable<string>` of text deltas that may return the answer as its return value, with an optional, idempotent `settle({ spoken, interrupted })`. `createCogitatorRunner` implements it with `stream: true` and `onToken`. Its stream ends with the final model turn, so the last sentence does not wait for what the run does afterwards, and text the model says before a tool call ends with a line break so it is spoken on its own while the tool runs. A `PipelineSession` with such a runner splits the deltas into sentences and synthesizes them in order through `tts.streamSynthesize`, so the first audio goes out before the answer is complete. The splitter, exported as `SentenceSplitter`, keeps abbreviations, initials after a capitalized word, decimals and list numbers at the start of a line inside their sentence, keeps markdown marks after a stop with it, splits at `?!`, ellipses before a new sentence, CJK full stops and line breaks, flushes a tail without punctuation at the end and cuts a piece longer than `maxSentenceLength` (default 250, at least 20) on whitespace. Sessions emit a new `agent_response_delta` event for each piece of spoken text, forwarded to `VoiceAgent` clients as `{ type: 'agent_response_delta', text }`. `VoicePipeline.process()` returns one buffer and keeps using `run()` with a single `synthesize()` call.

  When a streamed turn stops early (an interruption, a barge-in, closing the session, or a model or TTS error), the session settles it with the sentences whose audio was sent to the client in full. The server cannot know how much of that audio the client played. With `createCogitatorRunner` the thread then holds what was spoken: the answer's assistant message is replaced by its spoken part with `metadata.interrupted: true`, or removed when nothing was spoken, and a run stopped before it saved an answer gets its spoken part saved after its `interrupt` event. A run that fails after saving its answer has that answer replaced too, and its error is reported once the turn was spoken. Text said alongside tool calls stays as the run saved it, and a turn spoken in full leaves the thread exactly as before. The thread is only changed while the turn's last entry is still its active leaf: when another run or your code wrote to the thread meanwhile, it is left as it is, so no newer message is hidden. The runner fixes the thread as soon as the run saved its answer, without waiting for its `afterRun` hooks, settles the turns of one thread one after another and starts a run once the previous run of its thread saved its answer, waiting for the rest of that run at most `tailTimeout` ms (a new `createCogitatorRunner` option, default 10 000), the next streamed turn of a session starts once the previous one settled, and both that wait and `close()` are bounded by `settleTimeout` (default 10 000 ms).

  `bargeIn: true` on `VoicePipeline` or a pipeline-mode `VoiceAgent` lets VAD speech during a reply stop it and start listening, with streaming runners and plain ones. It is off by default, since without echo cancellation on the client the agent's own voice would interrupt it.

  A realtime `VoiceAgent` without `tools` now gives the model the agent's own tools through the runner's new `realtimeTools()`. `createCogitatorRunner` builds them with `createRealtimeTools` and the agent, so each call goes through `cogitator.invokeTool` with the gates a text run of the agent applies: approvals, the guardrails (built with the agent's model unless `guardrails.model` is set), the agent's `wrapToolCall` middleware, the sandbox and `tool.timeout`, with the session's thread id. Unlike a text run, a tool that needs approval is refused unless `agentTools.onApproval` or `guardrails.onToolApproval` approves it (the model reads that it needs approval), and a realtime session sets no `maxIterations`. A runtime without `invokeTool`, such as a custom `CogitatorLike`, gets no tools. `agentTools` passes options, and `agentTools: false` turns it off. Explicit `tools` still win, `tools: []` included. `createRealtimeTools` takes `agent`, a `userId` that can be a function of the call's context, and an `onApproval(request, context)` that also gets the call's session.

  Core: `RunOptions.onMemoryEntry` is called with each entry a run saves to its thread, also for a run that is aborted or fails, before its promise rejects (a failed run now waits for its pending memory writes before it rejects). A throwing or rejecting callback is logged. `invokeTool` takes `agent`: the guardrails are built with its model unless `guardrails.model` is set, as for a run of it, its middleware wraps the call after the Cogitator's, and its id and name name the call. `ToolApprovalRequest` gains optional `agentId`, `threadId` and `userId`, set for `invokeTool` calls.

  Types and memory: `historyMessage(entry)` and `INTERRUPTED_REPLY_NOTE`. An assistant entry with `metadata.interrupted: true` reaches the model with `[interrupted by the user]` after its text, both from plain history and from the context builder, so the model does not take a cut-off reply for a finished one.

  Migration:

  - A pipeline `VoiceAgent` or `PipelineSession` built with `createCogitatorRunner` now streams. TTS is called once per sentence instead of once per answer, and `agent_response` can arrive while the first sentences are already playing. It carries what `run()` returns, the final model turn, as before.
  - A middleware that rewrites a turn's text in `afterModel` without `holdsStream: true` is heard before its rewrite in a streamed voice turn. Set `holdsStream: true` on it to speak only the final text.
  - A realtime `VoiceAgent` built with `createCogitatorRunner` and no `tools` now exposes the agent's tools to the model. Pass `agentTools: false` to keep the old behavior, and `agentTools: { onApproval }` for tools that need approval.
  - `maxSentenceLength` below 20 is rejected.
  - `RealtimeToolsOptions` moved to the package's shared types and is exported from the same place as before.

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/sandbox@0.6.21

## 0.58.0

### Minor Changes

- [#259](https://github.com/cogitator-ai/Cogitator-AI/pull/259) [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357) - A full AI SDK provider, Cogitator agents as AI SDK agents, the conversation as messages instead of a transcript, and agent events as custom parts

  `createCogitatorProvider` carries the members of its specification, so `createProviderRegistry` takes it. Its embedding and image models throw `NoSuchModelError`, and so does an unknown agent, which used to throw a plain `Error` with the same message.

  `toAISDKAgent(cogitator, agent, settings?)` from the new `@cogitator-ai/ai-sdk/agent` entry point (ai@7) is a `ToolLoopAgent` on `cogitatorModel()`, an AI SDK agent for everything that takes one.

  The prompt no longer reaches the agent as a `User:` / `Assistant:` / `Tool:` transcript. Its trailing user messages are the input, and the turns before them are the run's history as messages, tool calls and their results included, through the new `RunOptions.history` in core: the conversation the caller holds, read instead of the thread's memory, refused when it holds a system message. A prompt that does not end with a user message is now refused, unless it answers tool approvals.

  `providerOptions.cogitator` (`providerMetadata.cogitator` on ai@4) takes `threadId`, `userId` and `saveHistory`. With a `threadId`, the memory thread is the history and only the new turn of the prompt is used. A call without one no longer saves its turn to a thread of its own, which nothing could read back, unless `saveHistory: true`.

  `v4` models report handoffs and model fallbacks inside the run as custom parts, `cogitator.handoff` and `cogitator.model-fallback`.

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/memory@0.24.5
  - @cogitator-ai/sandbox@0.6.20

## 0.57.0

### Minor Changes

- [#256](https://github.com/cogitator-ai/Cogitator-AI/pull/256) [`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f) Thanks [@6alex6kash6](https://github.com/6alex6kash6)! - Add custom HTTP headers to Ollama provider configuration for authentication proxies and gateways. Headers reach both non-streaming and streaming chat requests, while the JSON content type is preserved and `apiKey` takes precedence over custom authorization regardless of header-name casing. Reject invalid HTTP headers when constructing the backend. Normalize all trailing slashes in the Ollama base URL before building request endpoints.

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/sandbox@0.6.19

## 0.56.4

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/memory@0.24.3

## 0.56.3

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/sandbox@0.6.18

## 0.56.2

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/memory@0.24.1
  - @cogitator-ai/sandbox@0.6.17

## 0.56.1

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/sandbox@0.6.16

## 0.56.0

### Minor Changes

- [#247](https://github.com/cogitator-ai/Cogitator-AI/pull/247) [`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682) - Forgetting a conversation now forgets what memory made of it. Every summary, memory item, fact, graph node and edge, vector and memory file keeps the entries it stands on, and deleting, redacting or rewinding those entries follows that lineage into every store, so a user who asks to be forgotten is not remembered through a fact or a playbook rule written from what they said.

  - Core: `Cogitator.forget({ entryIds } | { threadId } | { userId }, { agents?, graph?, keepReplies? })` deletes entries, a thread, or every thread of a user (by its `metadata.userId`, deleted whole) with the messages the user wrote in threads of others and everything kept for the user, with all memory derived from them. `Cogitator.redactEntries(entryIds, { agents?, graph?, keepReplies?, reason? })` replaces what entries said with `[redacted]` while they keep their place in the thread, and takes away what was derived from them the same way. `Cogitator.rewind(threadId, toEntryId, { agents? })` rewinds a thread, and the memory items that stood only on the entries after `toEntryId` become `stale`. Each returns a `MemoryCascadeReport`. `MemoryCascadeCall` is the type of the options of `forget` and `redactEntries`, and `rewind` takes only `agents`.
  - Core: items, files, facts and the graph are kept by the memory id of an agent (its configured `id`, else its name), so every run now notes in the thread's metadata the memory id of its agent and of every agent it hands over to (`metadata.memoryAgentIds`), and the user it ran for (`metadata.memoryUserIds`). A cascade goes through the memory of the agents a thread names. A thread written before this release names only the agents that ran in it since, so pass `agents` (agents or their memory ids) for the ones before, and for a user without threads. The lists are read again just before each write, which narrows, but does not close, the window in which two runs writing at once keep only one name. Facts are reached when the memory adapter is a fact store, graph nodes and edges only with `graph` passed.
  - Core: all three methods throw `CogitatorError` (`VALIDATION_ERROR`) when no memory is configured or the agents to go through are not known (a thread that names none and no `agents`, or a user without threads), `redactEntries` also when the adapter cannot redact, and `rewind` also when the adapter has no branches. A store that fails part of the way throws its own error, and the call can be made again, as derived memory goes before the entries.
  - Core: `forget` and `redactEntries` drop the paused runs of the threads they touch (`threads` and `threadsChanged` in the report), also from an app's own `runCheckpoints` store, as their messages would bring back on resume what went.
  - Core: memory extraction and compaction after a run stop before their next model call once the run's branch is no longer the thread's active one, such as after a rewind or a checkout while they work, so nothing is learned or summarized from a branch the conversation left. Extraction also writes nothing a window's answer gave once the branch was left, and drops the items whose entries were forgotten or redacted while the model answered.
  - Memory: `MemoryExtractor.extract` takes `beforeWindow(own)`, which stops the extraction before a window's model call when it returns `false`, and `beforeWrite(items)`, which returns the items of a window to write. `CompactionService` refuses to write a summary whose entries were deleted or redacted while it was written.
  - Memory: `MemoryCascade` (`deleteEntries`, `redactEntries`, `deleteThread`, `deleteUser`, `rewind`) does the work over the stores it is given (`{ memory, items?, files?, graph?, facts?, embeddings? }`) for the agents in `{ agentIds, keepReplies? }`. With deleted or redacted entries go their copies in forks (a thread lists its forks in `metadata.memoryForks`, each copy names its original in `metadata.forkOf`, forks of forks followed), the compaction summaries that cover them (the entries before `firstKeptEntryId` on their branch, or, when that entry is gone, those at or before the last entry left out) or quote them in an atom, so the next compaction writes them again, legacy summaries kept as messages (`metadata.compactionSummary`, adapters without branches) whose atoms quote them, the memory items, facts and graph nodes and edges that stand only on them (those that stand on more lose the quotes of them, and the entities no item is about any more are deleted), the vectors of the entries, the summaries and the facts that go (deleted from `embeddings` by source, whether or not a message index listens), the memory file versions written at them, and every version of an observation or a playbook that names an item or a lesson that went. A memory file whose version in front a cascade redacted is then deleted, so its path leaves the listing once no version on any branch still holds its text and its history keeps the redacted versions. A playbook in front is first written again without the rules that stood on such a lesson, and an observation is written again by the next refresh. A cascade looks for derived memory again after the entries went, so an item written meanwhile goes too.
  - Memory: a user message takes its replies (the entries after it on every branch up to the next user message, events such as a model change or an approval among them), as an answer may say again what it said, unless `keepReplies`. Redacting deletes an event entry among the entries or their replies (`model_change`, `approval`, `interrupt`, `label`, `custom`, or a `compaction` among the ids) instead and lists it in `entries.deleted`. A rewind marks the items stale before it moves the thread, so one that failed can be made again (a rewind the store refuses leaves them as they were), and a thread that stands at `toEntryId` already is left as it is. `deleteThread` also purges the items and entities and redacts the memory file versions kept for the thread alone, and takes the copies of its entries in its forks. `deleteUser` deletes every thread of the user whole, the messages others wrote in them too, and the messages the user wrote in threads of others (those that list the user in `metadata.memoryUserIds`) with their replies, listing every thread to find them, purges the items and entities and redacts the memory file versions of the user's scope, and deletes the facts and graph nodes and edges whose `metadata.userId` is the user and the embeddings with that metadata (`deleteByFilter`). `MemoryCascadeReport` lists `threadsChanged`, the threads that lost or had redacted some of their entries.
  - Memory: every built-in adapter (in-memory, SQLite, Postgres, Redis, MongoDB) has `redactEntry(entryId, { at, reason? })`: the entry's text, the arguments of its tool calls and the results of its tools become `[redacted]`, its tool calls lose their replay state and argument error, a user message loses its sender `name`, its place, parent, role and call ids stay, `metadata.redacted` records when and why, an event entry such as a compaction is refused, and a missing entry gives `null`. Change listeners hear `{ type: 'entry-redacted', entryId, threadId }`, and the message index drops the entry's vectors. `forkThread` lists the fork in the origin's `metadata.memoryForks` and no longer copies the paused run of its origin. `redactedEntry`, `REDACTED_TEXT`, `FORKS_KEY` (`'memoryForks'`) and `MEMORY_USERS_KEY` (`'memoryUserIds'`) are exported. `MemoryItems.reviseEvidence(itemIds, keep)` keeps the evidence pieces `keep` takes and returns the ids it changed.
  - Types: `MemoryAdapter.redactEntry?`, `EntryRedaction` (`at`, `reason?`), and `entry-redacted` among the `MemoryChange` events, so an exhaustive `switch` over `MemoryChange` needs the new case.
  - Test utils: the memory adapter conformance suite checks `redactEntry` in the scenario `redacts-an-entry-in-place`, also that a redacted entry keeps its parent and that an event entry is refused.

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/sandbox@0.6.15

## 0.55.0

### Minor Changes

- [#246](https://github.com/cogitator-ai/Cogitator-AI/pull/246) [`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76) - Memory works between runs, not only while a run builds its context. A brief hands a turn a few cards of what memory holds for it, each quoting its source, observations keep what memory makes of each entity next to the facts, and a consolidation pass in the background marks repeats stale and folds lessons into a playbook a few edits at a time. Every piece asks a model and checks what it answers before anything is kept, and all of them are off unless set.

  - Core: `memory.brief` (`model`, `maxCards` from 1 to 4, `timeoutMs` 4000, `maxTokens` 600, `prompt`, a value outside these throwing when the runtime builds the brief). Before the first model call of a run a cheap model reads the 12 best sources memory finds for the input, earlier turns of the run's branch and the memory items the run sees, ranked as `hybrid` recall ranks them, and writes cards, each a `constraint`, `knowledge`, a `consequence` or an `open_thread` quoting its source. Only cards whose quote the source holds word for word, spacing and case aside, go into the turn's memory context, marked as a hint and never into the system message. A timeout, a failure, a run without memory or nothing found leaves the turn as it was. `memoryBriefMiddleware(config, deps)` is the middleware behind it.
  - Core: `memory.observations` (`model`, `maxEntities` 3, `minItems` 3, `prompt`). After a run, in the background, the observations whose facts changed are written again as memory files under `/memories/observations/`, each statement citing the items it stands on, and a turn whose input names an entity, or that recalls one of its items, gets up to three of them next to the facts. Observations reach a turn only with `memory.contextBuilder` set, and are written either way.
  - Core: `memory.consolidation` (`model`, `everyRuns` 20, `afterCompaction` true, `maxChanges` 10, `maxSubjects` 10, `playbook` `apply`, `shadow` or `false`, `showPlaybook` true, `prompt`, `afterConsolidate`). Every `everyRuns` runs of a thread, and after `memory.compaction` compacted it (a compaction that changed nothing starts none), a pass marks as stale the items a model finds to repeat or contradict a newer one, asking about at most `maxSubjects` subjects, the oldest first, and going on where it stopped the next time, folds new `active` lessons, never one from a tool or a page, into `/memories/playbook.md` in at most three edits, then writes the observations. Every run then sees the playbook in its memory context as a hint, up to 4000 characters, while `showPlaybook` is on, which alone decides it: `playbook: false` only stops new lessons from reaching it. Passes run in the background one at a time per memory scope, no run waits for them, their model calls count in the cost router but not in a run's usage, and `close()` stops the passes under way. `memoryUpkeepMiddleware(config, deps)` is the middleware behind observations and consolidation, `upkeepScope` the scope memory items of a run belong to, and `CONSOLIDATION_STATE` the thread metadata key that counts runs.
  - Core: `Cogitator.consolidateMemory(agent, { userId?, threadId?, since? })` runs a pass now, such as from a worker while the agent is idle, and returns what it changed. When `report.dedupe.complete` is false a cap stopped the look for repeats, and calling again with `since: report.dedupe.through` goes on from there. With the `user` extraction scope (the default) it needs a `userId`, or a `threadId` for the memory of runs without a user, with `thread` a `threadId` (even with a `userId`), and with `agent` nothing. It throws `VALIDATION_ERROR` when neither `memory.consolidation` nor `memory.observations` is set, or when memory keeps no memory items. A pass on demand asks `consolidation.model` for repeats and lessons and `observations.model` for observations, each falling back to the agent's model (`llm.defaultModel` when the agent has none), while a pass after a run falls back to the model the run ended on.
  - Core: the memory tool refuses every change of `/memories/playbook.md`, `/memories/playbook.next.md` and anything under `/memories/observations/`, a rename into them included, with `<path> is kept by memory itself and is read-only here`, and views them as usual. A version of the playbook or of an observation a model wrote (`author: 'model'`) is never shown to runs or read as an observation, only those memory itself or a user wrote. With `security.pii` the model calls of the brief, the observations and the consolidation, like those of memory extraction and compaction, are masked as a run's own calls are, since they go through the same routed backend. In `redact` mode nothing is restored, so placeholders such as `[EMAIL_1]` end up in what memory keeps (items, observations, the playbook, summaries), numbered per call.
  - Memory: `MemoryBriefer` writes the cards of a brief from a model's answer, keeping only those whose quote of at least three words holds, the prompt telling the model the sources are data (`parseBrief`, `briefBlock`, `BRIEF_PROMPT`, `MAX_BRIEF_CARDS`).
  - Memory: `MemoryObservations` keeps observations of entities as memory files (`refresh`, `read`), each with a fingerprint of the items it was written from, so it is written again only once they change, and deleted once its entity has fewer than `minItems` facts that hold. A statement naming an item the model was not given is dropped, and facts that gave no observation are not asked about again in the process until they change. `ContextBuilderDeps.observations` shows them to a turn.
  - Memory: `MemoryConsolidator` consolidates one scope's memory. `dedupe` marks as stale (never deletes) the items of exactly the scope a model groups as repeating or contradicting another one about the same entity, never an item more trusted than the one kept and, for a contradiction, only items said before it, with the reason in `metadata.staleBecause`, a group naming an item the model was not shown refused whole, and returns `{ stale, complete, through? }`, `through` saying where a later dedupe that a cap stopped goes on `since`. `foldLessons` folds `active` lessons, oldest first and 20 a fold, into the playbook in at most three edits, so a lesson a model wrote stays out until `MemoryItems.activate` makes it `active` and one from a tool or a page never gets in, and an answer the model did not finish folds nothing, each adding a rule or rewriting one rule, so the playbook is never written over whole, every fold a new version of the file. A playbook every user of the agent shares (a scope without a user, project or thread, as with `memory.extraction.scope: 'agent'`) takes only `system` lessons in `apply` mode, since one user's lesson would reach every other user, and `shadow` drafts the rest for review. Lessons are ordered and folded by when they were activated (`MemoryItems.activate` keeps `metadata.activatedAt`), else by when they were recorded, so a lesson activated after a fold is still folded. A fold builds on the newest version of the playbook memory or a person wrote, skipping one a model wrote, and `promotePlaybook` refuses a draft a model wrote. With `mode: 'shadow'` the edited playbook goes to `/memories/playbook.next.md`, and `promotePlaybook` makes it the playbook only when the playbook did not change since.
  - Memory: `MemoryFiles.put(access, path, text, expectedSha256?)` writes a whole file, created when it does not exist, failing when the file no longer stands as the caller read it. `MemoryItems.markStale(itemIds, because?, onlyFrom?)` returns the ids it marked (a report lists only those), keeps `because` in the items' `metadata.staleBecause`, and with `onlyFrom` leaves an item whose status is no longer one of those as it is. `MemoryFileAccess.reserved` lists paths no change may touch, and `MEMORY_RESERVED_PATHS` names the ones memory writes itself. `inert` is exported.
  - Config: `MemoryBriefConfigSchema`, `MemoryObservationsConfigSchema` and `MemoryConsolidationConfigSchema` validate `memory.brief`, `memory.observations` and `memory.consolidation`.
  - Types: `MemoryConsolidationReport.playbook` is `{ path, editCount, lessonIds }` and `MemoryConsolidationReport.dedupe` is `{ complete, through? }`. `MemoryBriefConfig`, `BriefCard`, `BriefCardKind`, `MemoryObservationsConfig`, `MemoryConsolidationConfig`, `MemoryConsolidationReport`, `StaleMark`, `MemoryConfig.brief`, `MemoryConfig.observations` and `MemoryConfig.consolidation`, `RunMiddlewareContext.memoryAgentId`, and `observations` among the sources of `ContextBuildError`.

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/sandbox@0.6.14

## 0.54.0

### Minor Changes

- [#244](https://github.com/cogitator-ai/Cogitator-AI/pull/244) [`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627) - Agents search their memory themselves and keep notes in memory files. The memory search tools find earlier turns and memory items with the same search the `hybrid` context recalls with, a citation lock keeps an answer to what the run opened, and `memory.files` gives every agent a `/memories` directory it edits with the commands of Anthropic's memory tool, native on Claude and a plain tool everywhere else.

  - Core: `createMemorySearchTools({ memory, agentId, items?, embedding?, messageIndex?, timeZone?, placeOf? })` makes `search_memory` (earlier turns of the branch the run stands on, the entries the run saved itself left out, and memory items in one ranked list, through `MemoryRetriever`, with dates in the given time zone), `open_turns` (turns whole with the turns around them) and `list_entities` (the people, places and things memory knows, with how many items are about each). Results carry references to cite, `[item:<id>]` for an item a search returned and `[turn:<id>]` for a turn `open_turns` opened. `Cogitator.memorySearchTools(memoryAgentId)` builds them over the runtime's store, memory items, embedding service and message index, and throws `VALIDATION_ERROR` without memory. `MEMORY_SEARCH_TOOLS` names them.
  - Core: `memoryCitations({ tools?, onUncited? })` is a run middleware that takes out of a final answer each `[turn:<id>]` or `[item:<id>]` the run's memory tools never handed out, and calls `onUncited` with them. References are read only from the `ref` fields of the tools' results, never from text quoted inside them, and an answer's references are read in lists, with spaces, in capitals and in fullwidth brackets. An answer without references is left as it is, what a run opened is read back from its tool results too, so a resumed run still knows it, and the middleware holds the stream.
  - Core: `recall` of `createMemoryTools` ranks memory items with `MemoryRetriever` when it is given the thread store (`memory`), by their words, the entities they name and the graph around them, instead of matching every word of the query.
  - Core: with `memory.files` every agent a Cogitator runs gets the `memory` tool (`memoryFileTool`, `MEMORY_FILE_TOOL`): `view`, `create`, `str_replace`, `insert`, `delete` and `rename` under `/memories`, with the answers and errors of Anthropic's memory tool, kept under the agent's memory id. The files the run sees are listed in its memory context, each with its size and first line, up to `indexChars`. A tool of the agent's own named `memory` takes its place, a store that keeps no memory files is warned about once, and unless `scope` is `agent` the tool refuses a run with neither a user nor a conversation.
  - Core: `ToolConfig.providerTypes` and `ToolSchema.providerTypes` name a tool's type in a provider's own catalog. The Anthropic backend sends such a tool as that type instead of its schema, so Claude 4 and later get the memory tool as `memory_20250818`, older Claude models get its schema, and every other backend sends the schema as before.
  - Memory: `MemoryFiles` reads and changes memory files as the tool does (`run`, `view`, `create`, `strReplace`, `insert`, `delete`, `rename`, `list`, `read`, `history`, `redact`, `index`). Every change is a version of its own, never overwritten. A run sees the files of its user, its thread and the agent, the narrowest scope winning, and in its own thread only the versions written on its branch. A change goes into the run's scope, or the scope with every limit of the version it changes (and of a moved file's source), and names that version (`previousId`). One change keeps at most 8 MiB. An edit of a file another writer changed since it was viewed fails, two writers never add the same version, a change of many files is added whole or not at all, `readOnly` refuses every change, paths outside `/memories`, control characters, names past 255 characters, a file under a file, NUL characters and files over 1 MiB (`MAX_FILE_BYTES`) are refused, an edit, deletion or rename of a file changed since the run viewed it fails, and `redact` replaces the content of a file's versions with `[redacted]`, following the file's own history across renames, never into another file that took an old path, and in every scope of the agent with `everyScope`, while its history stays. `MemoryFileAccess.observe` hears of the version each command showed or wrote, which the tool keeps for its edit lock. A refused command throws `MemoryFileError` with the message the model reads.
  - Memory: every built-in adapter keeps memory file versions (`MemoryFileAdapter`): InMemory in process, SQLite in a `memory_file_versions` table, Postgres in `<schema>.memory_file_versions`, MongoDB in `<prefix>file_batches` (the versions of one change in one document) and `<prefix>file_places` (a place a dead writer never published is taken again after a minute), and Redis as hashes never under the thread `ttl`. `isMemoryFileAdapter`, `memoryPath`, `MEMORY_ROOT`, `MAX_FILE_BYTES`, `REDACTED_CONTENT`, `sha256Of`, `matchesFileFilter`, `byFileVersion` and `fileKeyOf` are exported for stores of your own.
  - Memory: `MemoryRetriever`, `analyzeQuery`, `timeExpressionOf`, `MIN_COSINE`, `RELATIVE_COSINE` and their types (`Retrieval`, `RetrievalRequest`, `RetrievedEntry`, `RetrievedItem`, `QueryAnalysis`, `QueryType`) are exported, the search of `hybrid` recall as its own class.
  - Memory: the Postgres schema moves to version 4. The first `connect()` after upgrading creates the new `memory_file_versions` table, empty, and changes nothing else, so nothing is migrated.
  - Config: `memory.files` (`MemoryFilesConfigSchema`): `scope` (`user`, `agent` or `thread`), `readOnly` and `indexChars`, a whole number above 0.
  - Types: `MemoryFileVersion`, `MemoryFileFilter`, `MemoryFileAdapter`, `MemoryFileAuthor`, `MEMORY_FILE_CONFLICT`, `MemoryFilesConfig` and `MemoryConfig.files`, and `ProviderToolTypes` on `Tool`, `ToolConfig` and `ToolSchema`.
  - Test utils: `memoryFileAdapterConformanceCases` checks a store of memory files against the contract the built-in ones keep: versions read back field for field, a taken place refused with `MEMORY_FILE_CONFLICT`, also when writers race for it, a refused batch keeping nothing, the filters and their order, redaction, deletion and copies.

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/sandbox@0.6.13

## 0.53.0

### Minor Changes

- [#227](https://github.com/cogitator-ai/Cogitator-AI/pull/227) [`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Readiness checks and memory adapter health check contract ([#103](https://github.com/cogitator-ai/Cogitator-AI/issues/103)).

  - Add optional `healthCheck(): Promise<MemoryResult<void>>` to `MemoryAdapter` in `@cogitator-ai/types` and implement it for all five built-in memory adapters (in-memory, redis, postgres, sqlite, mongodb) using lightweight, non-mutating checks.
  - Add shared readiness check logic in `@cogitator-ai/server-shared` with a 3-second timeout per check. Adapters without `healthCheck()` report `unchecked` and fail open, and unconfigured memory does not fail readiness.
  - Update Express, Fastify, Hono, and Koa server adapters to check readiness against memory, returning HTTP 200 when ready and HTTP 503 on failure without exposing internal driver or network details.
  - Add `health-check` scenario to memory adapter conformance suite in `@cogitator-ai/test-utils`.
  - Update OpenAPI specification for `/ready` endpoint with `ReadinessResponse` schema.

- [#240](https://github.com/cogitator-ai/Cogitator-AI/pull/240) [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7) - The `hybrid` context strategy recalls what a turn needs from the whole thread and from memory items: the newest turns stay as history, where the prompt cache serves them, and a search of memory in channels brings older turns and items into the turn's memory context.

  - Memory: the `hybrid` strategy keeps the newest entries as history (`recent`, as the `recent` strategy does) and searches the older turns and the memory items the run's agent (under its memory id and its runtime id), user and thread see for the turn, one current state per slot as the facts choose it. What it finds goes into the `recall` partition (60% of the budget for `hybrid` unless the config sets a share, what it leaves unused going to the history), best first, under `Earlier in this conversation:` (each turn dated in the thread's time zone, with the turn next to it that makes it readable) and `From memory:` (each item with the interval it held when it no longer holds, or the date it is about, to the precision it was said with). An item the `facts` partition kept is not repeated, and `BuiltContext.recalled` (`{ entries, items }`) gives what was sent. An entry recalled this way is not in `dropped.entries`. `hybrid` needs a `currentInput` and searches without vectors when there is no `embeddingService`, and a turn that is small talk is not searched.
  - Memory: the search reads the turn without a model, as a `temporal`, `update`, `aggregate`, `preference` or `general` question with the time it names, and finds turns by their vectors (a cosine of 0.45 or more and 0.6 of the best), by BM25 over the thread, by the time the turn names and by the entities of memory it names, and items by BM25, by the vectors of their content (each item embedded once by the builder and kept, since items never change), by those entities, by the time they are about, by a personalized PageRank walk over the graph of items and entities, and turns through the evidence of the best items. Questions about time or many things search the past states of items too. The channels are fused by reciprocal rank with weights for the kind of question, reranked by the share of the input's words a hit holds, biased a little toward recent turns and toward items sent to a model more often, and laid out for diversity (MMR).
  - Memory: `ContextBuilderDeps.reranker` (any `Reranker`) reorders the best 30 hits of the search. A reranker that fails leaves the order as it was, with a `relevance` error.
  - Memory: `BuildContextOptions.asOf`, the moment the turn is read at (now by default): the time a turn names is resolved from it, and the facts and recalled items are read as of it. `ContextBuilderConfig.timeZone` (UTC by default, the constructor throws on a name that is not an IANA zone) and `BuildContextOptions.timeZone` (the thread's, ignored when not a valid zone) set the calendar of recalled dates and of the time a turn names.
  - Memory: `MemoryItems.noteRetrieved(itemIds, at?)` counts items as sent to a model once more (`timesRetrieved` one up, `lastRetrievedAt` set) in one step of the store, through `MemoryItemAdapter.countRetrieved`, which every built-in store has. A store without it has each item read again and written back under its agent's lock, as `purge` now runs too. Every built-in store keeps the two fields.
  - Memory: `MessageIndex` takes `vectorsKept`, about how many vectors it keeps, those of the threads used least lately dropped and indexed again when a build uses them. `InMemoryEmbeddingAdapter` indexes its embeddings by source and by thread, so replacing a source's vector and searching one thread no longer scan the whole store, and `MessageIndex` reads stored vectors in batches.
  - Core: with `relevant` or `hybrid` and `memory.embedding`, every memory gets a message index: in the embedding store (Postgres or `memory.qdrant`), else in process, the `memory` adapter always in process, and a lasting store without an embedding store keeps up to 50,000 vectors, of the threads used lately. `Cogitator.indexMemory(threadId)` embeds every entry of a thread the index has not reached, a page of 500 at a time, and returns once the vectors are stored, such as after an import (`MessageIndex.index`, which fails when the store refuses a vector). It does nothing without an index.
  - Core: `RunOptions.asOf` passes the moment of the turn to the context builder, and a run passes its thread's `metadata.timeZone`. The builder's `timeZone` defaults to `memory.extraction.timeZone`. `memory.reranker` reorders the hits of `hybrid` recall.
  - Core: a run counts the memory items it sent to the model, its facts and recalled items, once it finishes or pauses for approval, in the background, one count after another. A failure is logged, and `close()` waits for the counts.
  - Config: `memory.contextBuilder.timeZone` is validated as an IANA time zone.
  - Types: `MemoryItem.timesRetrieved` and `lastRetrievedAt` (not part of `NewMemoryItem`), the optional `MemoryItemAdapter.countRetrieved`, `BuiltContext.recalled`, `ContextBuilderConfig.timeZone`, `MemoryConfig.reranker` and `RunOptions.asOf`.
  - Test utils: the `item-round-trip` case of `memoryItemAdapterConformanceCases` checks that `timesRetrieved` and `lastRetrievedAt` come back, the latter as a date, and `count-retrieved` checks `countRetrieved` of a store that has it.
  - Cost: `relevant` and `hybrid` now embed every entry of a thread once, in the background, on every memory, not only the newest 200 entries a build scored. That is one embedding per message, plus one embedding of the input per turn.
  - Breaking: `hybrid` no longer mixes older entries into the history. They come in the turn's memory context instead, in the `recall` partition, and the history is the newest entries, as with `recent`.

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/sandbox@0.6.12

## 0.52.0

### Minor Changes

- [#229](https://github.com/cogitator-ai/Cogitator-AI/pull/229) [`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014) - What a conversation established is kept as memory items, extracted after each run, grounded in quotes, trusted by who said them and kept with when they held, and runs read them as their facts.

  - Types: `MemoryItem` (`kind` `fact`, `event`, `preference`, `instruction`, `opinion` or `lesson`, `status` `suggested`, `active`, `stale` or `superseded`, `trust` `user`, `system`, `model`, `tool` or `web`, a `scope` of `agentId` and optional `userId`, `projectId` and `threadId`, `evidence` and `verified`, `saidAt`, `sessionAt`, `about` as `{ text, start, end, precision }`, bitemporal `validFrom` and `validTo` for the items of a slot and `recordedAt` and `expiredAt`, `supersedes` and `supersededBy`), `NewMemoryItem`, `MemoryEntity`, `MemoryItemAdapter`, `MemoryItemFilter` (with storage-side scope filters `visibleTo` and `scope`), `MemoryEntityFilter`, `MemoryItemQuery` (`active` and `superseded` by default with the state that holds read from `validFrom` and `validTo`, `asOf` world time defaulting to `knownAt`, `knownAt` memory time defaulting to now, `includeClosed`, `text`, `limit`) and `MemoryExtractionConfig`, `MemoryConfig.extraction`. `RunEndEvent.memoryAgentId` (the id the agent's memory is kept under), `BuildContextOptions.memoryAgentId` and `SummarizeOptions.maxTokens`.
  - Memory: `MemoryItems` keeps the rules over any `MemoryItemAdapter`. Writes only add, and one agent's writes go one after another within a process, items of one millisecond recorded a millisecond apart. An item said again merges into the newest open one no other value followed since, else it is a new state, and on a merge the trust and `verified` come together from the better source (the more trusted one first, then the one whose quotes hold), so a `system` item stays `system` and a user's unverified claim stays the user's but `suggested`. Values of a slot compare by text (`sameValue`: spacing aside, case and signs count), content compares normalized. After every write of a state, the `active` and `superseded` items of its slot (its `subject` linked to an entity, and its `attribute`) and exact scope are laid out by time: each closed (`superseded`, `validTo`) when the next starts, the last open. So racing writers, a state told late (it fits between the ones around it) and a failed close converge, a state set to start later leaves the current one in place until it starts, and a state let go keeps its place, so the one before does not come back. `expire` and `purge` reopen nothing. `link` reuses an entity the writer's scope sees (its own or a broader one, such as the user's for a thread), so a slot is the same in a thread and in the user's memory, settles duplicates of racing writers on the first made and adds no aliases. An item becomes `active` on its own from `system`, or from `user` with quotes that hold at `activationConfidence` (default 0.7), everything else stays `suggested`, so what a model, a tool or a page wrote cannot plant itself. An opinion said again gains 0.1 only when the new statement has quotes that hold, and loses 0.2 when a less trusted source contradicts it. `query` (`asOf`, `knownAt`, `includeClosed`, `text`, recording time filtered only by an explicit `knownAt`), `history`, `activate`, `markStale`, `expire` (an item with a future `expiredAt` is found until then), `purge`, `link`, and `visibleIn`, `normalizeName`, `sameValue`, `slotOf`, `isMemoryItemAdapter`.
  - Memory: `resolveTime(expression, sessionAt, timeZone)` turns time words a model marked up (`date`, `relative`, `weekday`, `TimeExpression`) into an interval in a time zone, `end` exclusive, with its precision. `MemoryExtractor` reads entries in windows of `windowTokens` (default 4000), one call each with `EXTRACTION_PROMPT` and the session date (`sessionLine`), shows each message with its date, checks every quote against its entry, gives each item the trust of the least trusted entry among its quotes that hold (`parseExtraction`, `trustOfEntry(entry, userId)`, `web` for tools that fetch pages, `model` for another user's message), resolves relative dates from the date of the first message it quotes (its `saidAt` and `sessionAt`), and writes the items through `MemoryItems`. A `null` or blank field is read as absent, an item that does not fit is dropped, and only an answer with no JSON array fails (`ExtractionAnswerError`, `WindowError` from `extract` with the window's own entries). Each call asks for up to 8000 tokens, and `extract` takes `onWindow` and `skip` to keep its place and go on without a window. `isTimeZone` tells an IANA time zone.
  - Memory: every built-in adapter stores memory items: `InMemoryAdapter`, `SQLiteAdapter` (`memory_items`, `memory_entities`, `memory_entity_names`), `PostgresAdapter` (`memory_items`, `memory_entities`), `RedisAdapter` (never under the thread `ttl`) and `MongoDBAdapter` (`<prefix>items`, `<prefix>entities`). SQLite and Postgres keep the scope in `user_id`, `project_id` and `thread_id` columns and MongoDB at the top of the document, so `findItems` filters by scope in the store. With `includeFacts`, `ContextBuilder` reads the items the run's agent, user and thread see that hold now as its facts (`ContextBuilderDeps.memoryItems`), in place of `FactAdapter`: one state per slot (the one that started last, the narrowest scope on a tie), instructions and preferences first, newest first, an item that superseded another as `(previously: X)` only when the run sees that value and memory did not let it go.
  - Memory: `CoreFactsStore` keeps its API over memory items, each key the slot `core:<key>` of `system` items in a new optional `scope` (`{ agentId: 'core' }` by default): `set` supersedes the current value, `delete` lets it go and keeps the history. `PostgresAdapter`'s `FactAdapter` keeps its API over items too, each fact in its own slot `fact:<id>`: `updateFact` with new content supersedes the current item and keeps the old one as history, `deleteFact` deletes the fact with its history.
  - Core: `memory.extraction` extracts memory items after a run on the thread's active branch (a run whose leaf other runs appended after included, runs of one thread one after another), from the entries since the last extraction (the cursor in the thread's `metadata.memoryExtraction`, `EXTRACTION_CURSOR`) or for a first extraction the run's own, by `extraction.model` (the model the run ended on by default). The thread keeps its place after every window, a cursor on an abandoned branch is replaced by the run's branch point, and a window the model could not answer three extractions in a row is left out (counted in the cursor's `failures` and `failedThrough`), never one a provider, storage or abort failure stopped. A first extraction that fails stores where it started (`through` the branch point, `null` for the thread's start), so the next one takes those entries too. Items are kept under the agent's memory id, its configured id, else its name (`memoryAgentId(agent)`, exported), and belong to the run's own user (never the thread's owner) by default (`scope` `user`, `agent` or `thread`), to the thread for a run without a user, relative dates are resolved in the thread's `metadata.timeZone` when it is a valid IANA zone, else `timeZone`, else UTC, the calls are counted in the run's costs and `usage`, `afterExtract(items)` gets what was written, and an extraction that fails is logged while the run keeps its result, the thread left alone for a minute, doubled after each failure in a row up to an hour. It is the built-in middleware `cogitator:memory-extraction` (`memoryExtractionMiddleware`), whose `afterRun` runs before `cogitator:memory-compaction`. A Cogitator gives the context builder memory items for every store that keeps them, so `includeFacts` works on every built-in store, `memory` included. User messages a run with a user saves carry `metadata.userId`. `CompactionRun` is exported, and the runtime's summarizers pass `maxTokens`.
  - Core: `createMemoryTools` takes `items` (memory items `remember` writes to the user's scope, or the thread's for a run without a user, `recall` searches the user's and the thread's, and `forget` lets go only the run's own that hold the query as whole words, past and suggested states included) and `memory` (the thread store). `remember` takes a `quote`, and with `memory` it keeps a fact as the user's (graph `source: 'user'`, an item trusted as `user`, a core fact) only when the quote is in one of the run user's own messages among the 200 newest entries of the thread's active branch, else as a suggestion that never becomes a core fact. Its item is trusted as `user` whenever its graph node is the user's, and stays `suggested` without a quote that holds. `forget` says it forgets: graph facts are deleted, items expire.
  - Config: `MemoryExtractionConfigSchema` validates `memory.extraction`.
  - Channels: `RuntimeBuilder` gives the memory tools the memory store and memory items, so the assistant's `remember` checks quotes, and the assistant's agent id is its `name`.
  - Test utils: `memoryItemAdapterConformanceCases` checks a `MemoryItemAdapter` against the contract the built-in stores keep, scope filters (`find-visible-to`, `find-scope`) included.
  - Breaking: Postgres schema version 3. The first `connect()` after upgrading moves every row of `facts` into a memory item and renames the table `facts_legacy`. Upgrade every process that shares the database at once.
  - Breaking: `CoreFactsStore` keeps its facts in memory item tables. A database with the old `core_facts` and `core_facts_history` tables is moved on `initialize()`, and the tables are renamed `core_facts_legacy` and `core_facts_history_legacy`. Setting the value a key already holds no longer adds a history entry.
  - Breaking: `remember` given `memory` no longer trusts a fact whose quote is missing or not found in the run user's own messages on the thread's active branch: it is kept as a suggestion (graph `source: 'inferred'`, confidence 0.6) and is not saved as a core fact.
  - Breaking: the agent `RuntimeBuilder` builds has its `name` as its id instead of a generated one.
  - Breaking: a `FactAdapter` fact with empty evidence comes back without the `evidence` field.
  - Breaking: `RunEndEvent` has a required `memoryAgentId`, so code that builds one must pass it.
  - Breaking: a Cogitator keeps an agent's memory items under its configured `id`, else its `name`, so an agent without an id keeps them under its name, and agents of one name without an id share them.

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/sandbox@0.6.11

## 0.51.0

### Minor Changes

- [#228](https://github.com/cogitator-ai/Cogitator-AI/pull/228) [`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03) - A thread can be compacted into a tree of grounded atoms that is never summarized again and does not lose what is still open, and a Cogitator compacts a run's thread after the run.

  - `CompactionStrategy` gains `hierarchical`. The entries new since the last compaction, up to the kept tail, are read in chapters of about `chapterTokens` tokens (default 4000), each opening with the end of the one before, one at a time (`chapterConcurrency` reads more at once), and the summarizer lists the atoms of each, told the items still open before it so it can close them (`CompactionAtom`: `kind` `fact`, `task`, `decision`, `constraint`, `error`, `file` or `thread`, `status` `open` or `closed`, `text`, `evidence`, `verified`). Every quote is checked against its entry, an answer that is not a valid array is asked for again up to three tries, a constraint or a decision only tool outputs show is not verified, and files tool calls worked on, failed tool calls (known by their tool and files, or arguments when they name no files, and closed by a later call of the same tool on them that succeeds) and task lines (`TODO:`, `- [ ]`, closed by `- [x]`) are taken from the entries with no model. The transcript indents further lines of an entry and cuts one at about `chapterTokens`, and a part to compact under a tenth of the kept tail is left for later. Chapters beyond `chaptersPerArc` (default 4) fold into arcs and arcs beyond `arcsPerSaga` (default 4) into the saga, which keeps every open item and the newest 200 facts and files (`SAGA_ATOMS`), with no model, and an open item is closed only by an atom whose evidence holds. A control item is closed or opened again only by an atom whose evidence holds, and `messageThreshold` counts only the entries written since the last summary. The summary is written only when every open item of the one before is still there or was closed, else `compact()` throws and the thread stays as it was. The whole tree is one `compaction` entry, `CompactionEvent.levels` (`CompactionLevels` of `CompactionNode`s), and its message is the handoff, laid out as open tasks, constraints, decisions, unresolved errors, open questions, files, facts and done, in the same order every time so it stays in the prompt cache. `CompactionService.chapterAtoms(window, config, { own, open })` returns the checked atoms of one window. On an adapter without branches the levels are kept in the summary entry's metadata (`compactionLevels`).
  - `CompactionConfig.keepRecentTokens` keeps the newest tokens of the conversation verbatim for the `hierarchical` strategy, as whole turns that open with a user message, so a tool call keeps its result.
  - `memory.compaction` (`MemoryCompactionConfig`) compacts a run's thread `hierarchical`ly after the run once the conversation of its branch passes `at` (default 0.8) of the window of the model the run ended on, keeping `keepRecentTokens` (default the less of 20000 and a quarter of the window, unless only `keepRecent` is set). `beforeCompact({ threadId, tokens, threshold })` can return `false` to skip it or `{ instructions }` to add to the summarizer's prompt, and `afterCompact(result)` gets the `CompactionResult`. A thread that outgrows its window again within two turns of its last compaction is not compacted again, with a warning to clear tool outputs (`context.clearToolOutputs`) instead, a run on another branch than the active one is left alone, and a compaction that fails is logged while the run keeps its result, and the thread is left alone for a minute, doubled after each failure in a row up to an hour. The summarizer's calls are counted in the run's costs and in the `usage` it returns, and they stop with the run's signal. `compact()` refuses `chapterTokens`, `chapterConcurrency`, `chaptersPerArc` and `arcsPerSaga` that are not whole numbers above 0 (`checkCompactionSettings`). It is the built-in middleware `cogitator:memory-compaction` (`memoryCompactionMiddleware`), and `MemoryCompactionConfigSchema` validates it in `@cogitator-ai/config`.
  - Run middleware gets an `afterRun({ result, model }, context)` hook (`RunEndEvent`), called once a run finished and its writes settled, before `run()` returns. It is not called for a run that failed or paused, and an error it throws is logged without failing the run, the next hook still running.
  - Core: `anthropicCompactionSummarizer({ model, client?, apiKey?, maxTokens? })` is a `SummarizeFn` that has Anthropic's compaction on request (`ANTHROPIC_COMPACTION_BETA`, `compact-2026-09-04`) write the answer, with the prompt as its instructions. The answer is parsed and checked like any other, and the signed block is not kept, so the conversation goes on with Cogitator's own summary on every model.
  - Channels: the gateway's summarizer asks the model and prompt each call names, falling back to `summaryModel` and `summaryPrompt`, then to the agent's model. `Gateway.compactAll()` compacts every thread served since the start and the thread of every stored session (unless `session.threadKey` is set), one at a time past those that fail, and `/compact all` with `RuntimeBuilder` calls it instead of compacting a thread named `all`.
  - Breaking: `RuntimeBuilder` (`cogitator up`) compacts chat threads with the `hierarchical` strategy, keeping about 4000 tokens (`keepRecentTokens`) of the newest turns verbatim, instead of the `summary` strategy that kept the 10 newest messages. A thread compacted before is read on: its old summary becomes one closed, unverified fact of the first chapter.

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/sandbox@0.6.10

## 0.50.0

### Minor Changes

- [#226](https://github.com/cogitator-ai/Cogitator-AI/pull/226) [`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077) - A context is assembled by partitions and ordered for the prompt cache, and old tool outputs can be cleared before anything is summarized.

  - `ContextAssembler` shares a token budget among the partitions of a context (`ContextPartition`): `system`, `pinned`, `index`, `summaries`, `facts`, `recall`, `brief`, `recent` and `final`. Each has a `ContextPartitionBudget` (`share`, `required`). By default (`DEFAULT_PARTITIONS`) `system`, `pinned`, `index`, `summaries`, `brief` and `final` are required, `facts` takes 15%, `recall` 35% and `recent` the rest. Required partitions are fitted first, the others split what they leave by their shares, and what the shares cannot place goes to the partitions still short of room in fill order, `recent` last. The shares of the partitions that are not required add up to 1 at most, or the constructor throws. A text block is left out as a duplicate when a block a more lasting partition kept holds all of it, word for word. `fitInOrder` is the default fit.
  - `ContextBuilder` builds on it. Its config takes `partitions`, merged over the defaults, and `build()` takes `pinned`, `index`, `brief` and `reserveTokens`. It counts `currentInput` in the budget as the `final` partition. `BuiltContext` gains `memoryContext` (the brief, facts, search results and graph context as one text) and `partitions` (tokens per partition), and `DroppedContext.blocks` lists every left out block (`DroppedBlock`) with its partition, tokens, source and `DroppedReason`: `budget`, `duplicate`, `not-selected` or `oversized`. `formatTurnContext(blocks)` builds the turn context, a `<memory_context>` block, from texts of your own, `extendTurnContext(text, block)` adds a block to the one in front of an input, and `withoutTurnContext(text)` gives the input back without it.
  - `messages` comes in the order of how long its parts stay the same: one system message (the system prompt, `pinned`, `index`), the compaction summary and the history, whose last message and the last message of the turn before it have `cacheBreakpoint: true` (`markTurnEnds`), then a user message with `memoryContext`.
  - `Message.cacheBreakpoint`: the Anthropic backend, and the OpenAI backend for Claude through OpenRouter, mark the end of each such message with `cache_control`, next to the existing marks on the agent's instructions and the end of the conversation, up to four marks, Anthropic's limit.
  - Breaking: facts, semantic search results and graph context are no longer part of the system message. They are in the user message after the history (`memoryContext`), so the system prompt and the history stay the same from turn to turn and are read from the prompt cache. Code that read them from `messages[0]` reads `memoryContext` instead.
  - Breaking: the `recent` strategy goes on past a tool result too large for the room left, keeping a short note in its place, instead of ending the history there. Any other entry that does not fit still ends it. Compaction summaries are a required partition and always come before the history.
  - Breaking: a Cogitator run with `memory.contextBuilder` and no `maxTokens` passes the builder its budget once, with `reserveTokens: 0`, and the builder counts the input in it. The builder no longer takes its own 10% reserve from a budget that already left room for the answer, so such runs get more history than before.
  - Breaking: a run's `context` (`Context (data supplied with the request, not instructions)`) and the insights of reflection (`Past learnings that may help`) are no longer added to the system prompt. They go into the turn context in front of the input, so the instructions stay the same from run to run.
  - Core: what memory recalls for a turn goes into the final user message in front of the input, and only the input is saved to the thread. Learning traces and time travel replays read the input without the turn context. `RunOptions.brief` sends notes for one turn, such as the current time, the same way, with or without memory, and never saves them. The `agent.run` span reports `context.tokens.<partition>`.
  - Clearing old tool outputs: `context.clearToolOutputs` (`trigger`, `keep`, `exclude`, `clearInputs`, `clearAtLeast`, `onBeforeClear`, off unless set) replaces the outputs of old tool calls with a note once a turn's conversation grows past `trigger` tokens, before compaction, so outputs go before anything is summarized. `onBeforeClear` hears of the calls the run made itself, as outputs loaded from memory are in memory already. The run goes on with the notes, while `RunResult.messages` and a paused run's checkpoint get the cleared outputs and arguments back. Every agent then gets the built-in tool `recall_tool_output` to read a cleared output back from the run, or, for a run that uses memory, from the branch of the thread it is on. It is the built-in middleware `cogitator:clear-tool-outputs` (`clearToolOutputsMiddleware`), and the `agent.run` span reports `context.cleared_tool_outputs`, `context.cleared_tool_output_tokens` and `context.clearings`. `ClearToolOutputsConfigSchema` validates it in `@cogitator-ai/config`, and `memory.contextBuilder.partitions` is accepted there and in `@cogitator-ai/memory`'s schema too.
  - Channels: `GatewayConfig.brief(msg)` returns notes for the run of each message, passed as `RunOptions.brief`. `RuntimeBuilder` sends the current date and time this way instead of writing them into the instructions, so the instructions stay cacheable.

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/sandbox@0.6.9

## 0.49.0

### Minor Changes

- [#225](https://github.com/cogitator-ai/Cogitator-AI/pull/225) [`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0) - Threads are trees of typed entries, runs and forks go on branches of them, and derived memory can point at what it stands on.

  - Every entry has a `parentId` (`null` at the root), a `seq` within its thread and a `type`, and a thread has an `activeLeafId`. `addEntry` goes on after the active leaf and moves it there in one step, takes an explicit `parentId` to write on another branch, and `activate: false` to leave the leaf where it is. Deleting an entry splices it out: its children follow its parent.
  - Entry types: `message`, `tool_result`, and the events `model_change`, `compaction`, `approval`, `interrupt`, `label` and `custom`, which carry an `event` payload. `getEntries` and `getPath` return only `message` and `tool_result` unless `types` asks for more (or `'all'`), so readers that know nothing of events keep seeing the conversation.
  - `getPath({ threadId, leafId?, limit?, before?, types? })` reads one branch from the root to its leaf, the newest `limit` entries and pages before an entry, without reading the whole thread. `rewind(threadId, toEntryId)` moves the leaf back along its branch and deletes nothing, `checkout(threadId, entryId)` makes any branch active, and `forkThread(threadId, atEntryId, newThreadId?)` copies a branch into a new thread (`metadata.forkOf` on the copies, `metadata.forkedFrom` on the thread). Every built-in adapter implements them, adapters of your own get them by extending the new `BranchingMemoryAdapter` and implementing `setActiveLeaf`, which must refuse an entry that is not in the thread.
  - Entries written before this version are chained by time when first met: Postgres moves its schema to version 2 on `connect()`, SQLite migrates by `user_version`, Redis and MongoDB chain a thread the first time it is read or written. Upgrade every process that shares a store together, as an older process appends without a parent.
  - `ContextBuilder` and the runtime read the active branch instead of the whole thread.
  - Compaction deletes nothing on adapters with branches: it adds a `compaction` entry at the end of the active branch that names the first kept entry (`CompactionEvent`) and holds the summary. `readCompactedHistory(memory, { threadId })` reads the conversation of a branch as that summary, the kept entries and everything after them, in pages back only to the compaction's start (`compactedHistory(path)` does the same for a path already read), and `ContextBuilder` and the runtime read history this way. Other branches and evidence keep the summarized entries, and `getEntries` still returns them. `sliding-window` leaves entries out the same way. A compaction whose active branch moved to another branch while the summary was written fails instead of writing a summary of the wrong conversation. Adapters without `getPath` compact as before.
  - Breaking: Redis keeps memory with no expiry by default (`ttl: 0`), where it used to expire after 24 hours. Pass `ttl` to keep the old behaviour. The in-process `memory` adapter counts `maxEntries` per thread, not across all threads, and evicts entries of inactive branches first.
  - Runs on branches: `RunOptions.branch: { fromEntryId, activate? }` reads history along the branch that ends at `fromEntryId` (`null` for none) and chains the run's entries after it, and `RunResult.memory` says where the run wrote (`threadId`, `branchPoint`, `leafId`). The runtime records `model_change` when it falls back to another model, `approval` when a run pauses and `interrupt` when one is aborted, and a paused run resumes on its branch. A run with `activate: false` does not take the thread's place for a paused run: it is resumed with its checkpoint, and never abandons the paused run of the conversation.
  - Time travel: checkpoints keep where their run wrote, and live replays and forks go on a branch of the original thread from where the run started, without moving its active leaf. Forks of one run no longer share a `replay_<runId>` thread and see each other's entries. A replay goes on a thread of its own when the checkpoint has no place in memory, its branch point is gone, the conversation before the run was edited, or the thread belongs to a user other than the new `ReplayOptions.userId` / `ForkOptions.userId`.
  - Lineage: `Evidence { entryId?, toolCallId?, fileRange?, quote }` and an optional `evidence` on facts, graph nodes and edges and insights. Every built-in fact and graph store keeps it (a new `evidence` column in Postgres and SQLite, added on connect, and a JSON property in Neo4j), updates take it and `mergeNodes` keeps the evidence of merged nodes. `verifyEvidence` checks that a quote appears in its entry or tool result word for word, `verifyEvidenceInMemory` checks a list against stored entries, and `evidenceOnPath` keeps derived items whose evidence lies on a branch.
  - Studio: a Tree panel next to the chat (`T`) shows every branch of a thread in memory, with forks, events and the run that wrote each entry.
  - `@cogitator-ai/test-utils`: conformance cases for trees, branches, paths, rewind and checkout, forks, entry types, splicing deletes, new roots, deleting a branch point, checkout of a deleted entry and concurrent appends.
  - MongoDB writes to a thread's tree under a short per-thread lease on the thread document, so concurrent processes cannot leave an entry under a deleted parent, and reads paths without loading whole ancestor lists into one document. Redis scripts name their keys, so they route correctly in cluster mode. SQLite keeps an explicit `seq` instead of `rowid`.

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/sandbox@0.6.8

## 0.48.0

### Minor Changes

- [#224](https://github.com/cogitator-ai/Cogitator-AI/pull/224) [`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d) - Every message and document is embedded once.

  - `MessageIndex` keeps a vector per history entry in an embedding store (`sourceType: 'message'`). Attached to an adapter it embeds new user and assistant entries in the background, in batches, and deletes vectors with their entries and threads. `ContextBuilder` takes it as `messageIndex`: `relevant` and `hybrid` then embed only the input, read kept vectors for the newest entries and find older ones of the thread with a search of the store, so recall is no longer limited to the newest 200 entries. The `Cogitator` runtime sets one up for `relevant` and `hybrid` when `memory.embedding` and an embedding store are configured (the in-process `memory` adapter keeps vectors in process as before), and `close()` waits for its work. History written before the index is indexed in the background the first time a thread is built.
  - `MemoryAdapter.onChange(listener)` reports `entry-added`, `entry-deleted`, `thread-cleared` and `thread-deleted` once stored. Every built-in adapter implements it through the new `ChangeReportingMemoryAdapter` base, which adapters of your own can extend. Redis reports threads and entries it expired once a later write or read finds them gone, and its thread index now outlives threads by seven lifetimes for that.
  - Message vectors are marked `metadata.index: 'messages'` and carry the thread's `agentId` and `userId`, so user filters on a shared store leave out other users' messages.
  - `EmbeddingAdapter.getBySources(ids)` reads embeddings with their vectors by source, `replaceBySource(embedding)` stores one as the only embedding of its source atomically (so indexes of several processes leave one vector per message), and `SearchFilter.sourceTypes` takes a list of source types. Every built-in store implements all three, stores of your own keep working without them. Semantic context now searches only facts and documents: embeddings stored as `sourceType: 'message'` no longer show up in it.
  - With `relevant` or `hybrid`, the runtime now writes message vectors into `memory.qdrant` (and the Postgres store), so a read-only Qdrant key needs write access.
  - RAG: `ingest()` skips a source whose documents, chunker and embedding model did not change, and reports them as `unchanged`. A changed source is written as a new generation before the previous one is deleted, so it is never missing from queries, and its unchanged documents keep their vectors. The first chunk of each document is written last, so an ingest that stopped is finished by the next one. Chunkers get an optional `fingerprint`, which the built-in ones have and a source needs to be skipped. A local keyword index is filled from the store for skipped sources. Chunks carry `ragContentHash`, `ragGeneration` and `ragSourceDocuments`. Chunks stored by earlier versions are replaced once as before.
  - Postgres: vectors of 2001 to 4000 dimensions get an HNSW index on their `halfvec` cast (pgvector 0.7+) instead of none, in the memory store and both knowledge graph adapters. The memory schema version is recorded in `<schema>.cogitator_schema_migrations`, and `connect()` changes tables only when it is older or they are gone. Processes connecting at once take turns under a lock on the schema instead of failing on the same `CREATE`, in one transaction, so it also holds behind a pooler in transaction mode. A table of 2001 to 4000 dimensions from before gets its index on the first connect, which on a large table takes a while: build it ahead with `CREATE INDEX CONCURRENTLY idx_embeddings_vector ON <schema>.embeddings USING hnsw ((vector::halfvec(<n>)) halfvec_cosine_ops)`. New indexes on `embeddings(source_id)` and `metadata->>'threadId'`. Qdrant gets payload indexes on `sourceId`, `sourceType` and `metadata.threadId`.
  - `@cogitator-ai/test-utils`: conformance cases `reports-changes` and `get-by-sources`, and source type lists in `filters`.

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/sandbox@0.6.7

## 0.47.0

### Minor Changes

- [#223](https://github.com/cogitator-ai/Cogitator-AI/pull/223) [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913) - `RunOptions.onModelTurn` reports each model turn a run keeps, `{ content, toolCalls, model }`, as every `afterModel` middleware left it and before its tool calls run. A run without `stream: true` gets the text of a turn that calls tools only from here, and a run's own middleware, which sits inside the Cogitator's and the agent's, sees a turn before they do.

  A run that uses memory refuses an empty `threadId` with `VALIDATION_ERROR`, as memory adapters no longer create a thread without an id.

  A tool call that repeats the previous turn's calls, which the run answers with an error instead of running it, is now reported to `onToolCall` and `onToolResult` like any other.

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/sandbox@0.6.6

## 0.46.0

### Minor Changes

- [#220](https://github.com/cogitator-ai/Cogitator-AI/pull/220) [`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43) - Telemetry follows the OpenTelemetry GenAI semantic conventions, and runs that belong together share one trace.

  - Spans carry `gen_ai.*` attributes next to the existing `llm.*`, `tool.*` and `run.*` ones: `invoke_agent` on `agent.run`, `chat` on model calls (provider, request parameters, response id, finish reasons, token usage with cache reads, cache writes and reasoning), `execute_tool` on tool calls. `GEN_AI` names them all.
  - Streamed model calls record `gen_ai.response.time_to_first_chunk`.
  - Trace and span ids are W3C ids (32 and 16 hex characters) instead of `trace_…` and `span_…`. Code that parsed the old prefixes needs to treat ids as opaque strings. `agent.run` is now an `internal` span instead of `server`.
  - `RunOptions.trace` puts a run under a given parent, with `parseTraceparent` and `formatTraceparent` for W3C headers. A run started inside a tool of another run joins that run's trace under the tool's span, and `withTraceContext` does the same for any code.
  - `registerTelemetry(observer)` watches every runtime of the process, and `cogitator.recordSpan()` reports spans of your own orchestration to a runtime's observers.
  - `telemetry: { captureContent: true }` in the config, or `captureContent: true` on an observer, records system instructions, input and output messages, tool definitions, and tool arguments and results on the spans in the convention's JSON shapes. Observers that did not ask for content never receive it.
  - The OTLP exporter sends the convention's span names (`chat gpt-5.5`, `execute_tool search`, `invoke_agent researcher`) and array attributes, and keeps the Cogitator name as `cogitator.span_name`.
  - Workflows put agent runs under their node span, or under a `workflow.run` (`invoke_workflow`) span reported to the runtime's observers when no workflow tracer is on. Workflows running at once on one tracer no longer nest into each other. The `LLM_*` span attribute constants of workflows are deprecated in favour of `GEN_AI`.
  - Swarms report a `swarm.run` (`invoke_workflow`) span and run their agents under it, distributed swarms on their workers too.
  - A paused run reports its `agent.run` span with status `unset`, and a resumed run continues its trace. Time travel and learning traces are stored under the run id, since runs can now share a trace id: `timeTravel.compare()` and `getCheckpoints()` take a run id, and still take a trace id that belongs to one recorded run.
  - A workflow tracer given a `traceparent` with sampling flags `00` (through `setContextFromHeaders`) now leaves the workflow unsampled, as the caller asked, and the trace a workflow runs in takes precedence over a header the tracer kept from an earlier request.
  - The studio's trace inspector shows the instructions, prompt and response of every model call.

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/memory@0.13.3
  - @cogitator-ai/sandbox@0.6.5

## 0.45.0

### Minor Changes

- [#217](https://github.com/cogitator-ai/Cogitator-AI/pull/217) [`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45) - `memory.embedding` takes an `EmbeddingService` of your own as well as a provider's config. The runtime uses it as it is for the context builder and the embedding store, so a provider without a built-in service, or a cache in front of one, plugs in without wrapping the runtime. A config with `provider` works as before. A service is code, so it is passed to `new Cogitator()`, while `cogitator.yml` and `defineConfig()` keep taking provider configs only.

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/memory@0.13.2
  - @cogitator-ai/sandbox@0.6.4

## 0.44.0

### Minor Changes

- [#215](https://github.com/cogitator-ai/Cogitator-AI/pull/215) [`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e) - Runs take middleware: hooks around every model call and tool call, for what applies to all of them (masking, guards, caching, argument rewriting, logging). `middleware` on the Cogitator config, the agent and the run takes `RunMiddleware` objects with a `name` and any of five hooks: `beforeRun` checks a new run's input before anything is saved or sent (not called on `resume()`), `beforeModel` can return `{ messages }` to change the conversation from a turn on, `wrapModelCall` wraps each call to each model a turn tries (fallbacks included) and can change the request or the stream sink, call `next` more than once or answer without it, `afterModel` can replace a turn's `content` or `toolCalls` before the run uses them, and `wrapToolCall` wraps each tool call that passed approval and can change its arguments (checked against the tool's schema and `requiresApproval` again, an approval never carrying over to them) or answer for the tool. Every hook gets the run's context: `runId`, `threadId`, the agent, `userId`, the channel, `iteration`, `signal`, `deps` and a `state` map the run's middleware share.

  The Cogitator's middleware runs first, then the agent's (after a handoff, the agent the run went on as), then the run's. `before*` hooks run in that order, `wrap*` hooks nest with the first outermost, `afterModel` runs in reverse. A middleware with `holdsStream: true` makes a streamed run hold each turn's text until the turn is done and the hooks saw it, so text a hook retries, blocks or replaces never reaches a listener. Every call a `wrapModelCall` hook sends counts toward usage, cost and budgets, an answer it gives without the model counts nothing. The Cogitator's `wrapToolCall` hooks also wrap `invokeTool()`, which throws an error they throw, a tripwire among them, as that error would fail a run. A tripwire raised inside a tool, such as a nested run of an `agentAsTool()`, stops the outer run too instead of reaching the model as a tool error.

  `tripwire(reason, info?)` stops a run as a guard that tripped: it fails with the new error code `GUARDRAIL_TRIPPED` (HTTP 400), `details` holding the reason, `info` and the middleware's name, and `isTripwire(error)` tells it apart. Any other error a hook throws fails the run as it is.

  PII masking (`security.pii`), prompt injection detection (`security.promptInjection`), guardrails (`guardrails`) and compaction (`context`) now run as built-in middleware closest to the model, with the same behavior as before. PII masking of agent turns moved from the backend into its middleware, so it also masks what other middleware add, while the runtime's own model calls (guardrails, reflection, summaries) keep the masked backend. `piiMiddleware`, `promptInjectionMiddleware`, `guardrailsMiddleware` and `compactionMiddleware` build them, to give a feature to one agent only.

  A run without middleware of its own behaves exactly as before. `middleware` is code, so `agent.serialize()` and the agent wire format do not carry it, and `toAgentWire()` warns about an agent that has some. New exports: `tripwire`, `isTripwire`, `TripwireDetails`, the four middleware factories, `RunMiddleware`, `RunMiddlewareContext`, `RunInputEvent`, `ModelTurnEvent`, `ModelTurnUpdate`, `ModelCallRequest`, `ModelCallHandler`, `ModelStreamSink`, `ModelResponseEvent`, `ModelResponseUpdate`, `ToolCallRequest` and `ToolCallHandler`.

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/memory@0.13.1
  - @cogitator-ai/sandbox@0.6.3

## 0.43.0

### Minor Changes

- [#210](https://github.com/cogitator-ai/Cogitator-AI/pull/210) [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b) - A run's history is sized to the model it runs on. With `memory.contextBuilder` set and no `maxTokens`, the runtime used to keep every run within 4000 tokens of history, whatever the model. The budget is now the context window of the model the run starts on (from the model registry, then the model family, else 8192 tokens), minus room for the answer (the agent's `maxTokens`, else 15% of the window, at most half of it), the tool schemas and the input, and below the point where the context manager would compress, when it is on. A model on Ollama gets at most the 4096 tokens Ollama serves by default, except on Ollama Cloud (`https://ollama.com` as `llm.providers.ollama.baseUrl`, or a model tagged `cloud`). The builder keeps `reserveTokens` (10% of the budget by default) on top as slack, a run that leaves no room for history logs a warning, and an explicit `maxTokens` still wins.

  `ContextBuilder.build()` takes `maxTokens` per call, so one builder serves models of different sizes, and `ContextBuilderConfig.maxTokens` is optional: a build without a budget from either side throws, and a budget that is not a positive number throws too, `memory.contextBuilder.maxTokens: 0` included. `BuiltContext.dropped` (`DroppedContext`) lists what was left out: the history entries, facts, search results and graph nodes, with their token count. With the `relevant` and `hybrid` strategies the entries include those the selection passed over. `ContextBuilderConfigSchema` accepts a config without `maxTokens`, and `modelContextWindow(model)` from `@cogitator-ai/core` gives the window the runtime uses.

  **Migration:** runs with `memory.contextBuilder` and no `maxTokens` now send much more history on models with large windows, and every turn costs more on long threads. Set `memory.contextBuilder.maxTokens` to keep a cap, `4000` restores the previous behavior. If your Ollama server runs with a larger context (`OLLAMA_CONTEXT_LENGTH`), set `maxTokens` to use it. Code that builds `BuiltContext` objects of its own, such as test doubles, needs a `dropped` field.

- [#210](https://github.com/cogitator-ai/Cogitator-AI/pull/210) [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b) - Agents can fall back to other models. `fallbackModels` on an agent lists models a turn moves to, in order, when its model fails in a way another model may not: the provider is down, overloaded or timing out after its retries, the account is out of quota, the key is rejected, the model is gone, the prompt does not fit its context window or its answer could not be read. Rate limits and server errors are still retried on the same model first (`llm.retry`), quota, authentication, permission and missing-model errors move at once, and `content_filter` and `invalid_request` failures, which another model would refuse as well, never move. An aborted run never moves either.

  Each model has a circuit breaker shared by the runtime's runs, `llm.modelCircuitBreaker` (`failureThreshold` 5, `resetTimeout` 30 000 ms, `halfOpenRequests` 3 by default, also accepted by `cogitator.yml` through `@cogitator-ai/config`): a model that keeps failing, or fails in a way that lasts, is skipped until its breaker lets a call through again. A prompt too long for a model and a call cut short by the run's abort or timeout do not count against it. Every turn starts from the agent's model, a stream moves only before its first token, a fallback turn is priced at the model that answered it, `onModelFallback` and an `llm.fallback` span report every move, and `RunResult.modelUsed` names the model of the final answer. When every model fails the run ends with their shared error code, or `LLM_UNAVAILABLE` when they failed differently, each failure in `details.attempts`. `fallbackModels` survives `agent.serialize()` (and `Agent.validateSnapshot` checks it) and the agent wire format.

  A turn the provider ends with `finishReason: 'error'` moves like an unreadable answer, its tokens still counted. A turn that moves to a model with a smaller context window than the agent's model gets its messages cut to fit that window: the system prompt and the newest messages stay, and no tool result loses its call.

  An agent without `fallbackModels` behaves exactly as before. New exports: `FallbackModel`, `ModelFallbackEvent`, `ModelCircuitBreakerConfig` and `ModelCircuitBreakerConfigSchema`.

- [#210](https://github.com/cogitator-ai/Cogitator-AI/pull/210) [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b) - Tools can get typed per-run dependencies. `RunOptions.deps` reaches every tool of the run as `context.deps`, including tools of agents it hands over to, agents run with `agentAsTool` and `cogitator.invokeTool(tool, args, { deps })`. Unlike `context`, which is added to the system prompt, deps never reach the model, the memory, spans, the run result or a paused run's checkpoint, so `resume()` takes them again. Server adapters, channels, swarms, workflows and the worker start runs without deps for now.

  `ToolContext<Deps>` types `context.deps` for a tool. `new Agent<Deps>(...)` makes `deps` required in `run()` and `resume()` and refuses tools whose deps type is unrelated to `Deps`. Tool methods are compared loosely, so declare every field the agent's tools read in `Deps`.

  - `Tool`, `ToolConfig`, `tool()`, `AgentConfig`, `Agent`, `RunOptions` and `ResumeOptions` take the deps type as a new last type parameter that defaults to `unknown`, and `cogitator.run()`, `resume()`, `invokeTool()` and `agentAsTool()` are generic over it, so existing code compiles as it is.
  - New types: `BaseToolContext<Deps>` (the context a runtime hands a tool, with `deps?`), `RunDeps<Deps>` and `ToolInvocationOptions.deps`.
  - `ToolContext` is now a type alias over `BaseToolContext` instead of an interface. `interface X extends ToolContext` still works, but declaration merging into `ToolContext` (`declare module '@cogitator-ai/types' { interface ToolContext { ... } }`) no longer does: merge into `BaseToolContext` instead.

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/sandbox@0.6.2

## 0.42.0

### Minor Changes

- [#207](https://github.com/cogitator-ai/Cogitator-AI/pull/207) [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22) - Tools carry a `title`, an `outputSchema` and MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and they cross MCP in both directions. `getTools()` / `wrapMCPTools()` keep the server's title (or the title of its annotations), its hints and its output schema, as a zod schema of the result. `MCPServer` and `cogitatorToMCP()` advertise a tool's title, hints and `z.object()` output schema, and the server sends the result of such a tool as `structuredContent`, with its JSON as text for clients that read only `content`. A result the output schema rejects comes back as a tool error that says why. Only a `z.object()` output schema (`z.strictObject` and `z.looseObject` too) is advertised, since MCP output schemas need an object root and the MCP SDK takes them only as zod object schemas: a record, a union or a pipe is left out, and `MCPServer` warns when it registers such a tool. Nothing checks the output schema in a run.

  A tool the server marks destructive (`destructiveHint: true` without `readOnlyHint: true`) now needs approval: a Cogitator run pauses before it runs, and `invokeTool` asks `onApproval`. The new `requiresApproval` adapter option takes `true` (every tool), `false` (none) or a function of the MCP definition, and `isDestructiveMCPTool()` is the default check. A tool without the hint is not taken as destructive, although MCP's own default for a missing hint is `true`.

  `withParsedArguments(tool)` from core keeps a tool's approval, sandbox, timeout and result limit with a pass-through schema, for running through `invokeTool` a call whose arguments were already parsed with the tool's own schema. `MCPServer` uses it.

  **Migration:** agents whose MCP servers mark tools destructive now pause for approval before calling them. Approve them in your approval flow (`onApproval`, `cogitator.resume()`, the channels approvals), or pass `{ requiresApproval: false }` to `getTools()` / `wrapMCPTools()` for a server you trust (`requiresApproval: false` under `mcpServers.<name>` in a channels assistant config). Code that builds `MCPToolDefinition` objects by hand is unaffected, the new `title` and `outputSchema` fields are optional.

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/sandbox@0.6.1

## 0.41.0

### Minor Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - Tool names are checked where a tool is created. `tool()` (and `fromAISDKTool()` of `@cogitator-ai/ai-sdk`) throws a `TypeError` for a name that one of the providers refuses, naming the rule (letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters, the strictest of OpenAI, Anthropic, Gemini and Bedrock) and a name that fits. Such a name used to fail only once a run sent it, as a 400 from the provider, or worked on one provider and broke on the next.

  `assertToolName(name)` throws the same error for tools built without `tool()`. `normalizeToolName(name)` turns any name into one that fits (`weather.get` becomes `weather_get`, a name too long is cut and ends with a hash of the whole one), `normalizeToolNames(names)` does the same for a set and keeps it distinct, `isProviderSafeToolName(name)` checks one, `TOOL_NAME_MAX_LENGTH` is 64. The MCP adapter uses them, `normalizeMCPToolName` gives the same names as before.

  `ToolRegistry.register()` and `registerMany()` warn when a different tool takes a name that is registered, since the model can only call one of them. `{ replace: true }` replaces on purpose without a warning. In a run, a tool of the agent still replaces a tool of the same name in `cogitator.tools` quietly.

  `A2AClient.asToolFromCard()` names the tool after the card in a form providers accept: `Research Agent` becomes `Research_Agent`. A handoff to an agent with a long name gets a `transfer_to_...` tool name cut to fit, with a hash, and handoffs to agents whose names come out the same (`Billing EU` and `Billing/EU`, names in other scripts) get a hash each, so the model can reach every one of them. Tools an agent writes for itself with `create_tool` are refused, and skipped when loaded, when their name breaks the rule.

  **Migration:** a tool whose name breaks the rule now throws when it is created. Rename it, or wrap a name built from data in `normalizeToolName()`. Names with dots or colons that only Gemini accepted are among them.

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

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - A sandboxed execution stops when its signal aborts. `SandboxExecutionRequest` takes `signal`: aborting it kills the native process group, ends the Docker exec and removes its container (an aborted container is never reused), or closes the WASM plugin, which ends its worker. The result is a failure naming the reason, `Execution aborted: <reason>`, and a signal that is already aborted runs nothing. A Docker execution aborted while its container is still being pulled or started fails at once, and the container is removed when it comes up. A WASM execution aborted while its module downloads fails at once too.

  Core passes the run's signal to sandboxed tools, so cancelling a run stops a Docker or WASM tool instead of leaving it running until its own timeout, and the call fails with the abort reason, as a native tool does.

  The container pool removes a container once even when an aborted execution releases it while the pool shuts down, and `destroyAll()` waits for removals still in progress and for containers still starting, which it removes, so no container outlives the pool.

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/sandbox@0.6.0
  - @cogitator-ai/memory@0.12.8

## 0.40.0

### Minor Changes

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - Model prices of your own and an offline catalogue. `llm.pricing` sets prices in USD per million tokens by model, for a fine-tune, a model newer than the catalogue or a negotiated rate: `pricing: { 'openai/gpt-4o': { input: 2, output: 8 } }`. A key matches the model string a run uses or its tail after any `/`: `openai/gpt-4o` prices that model string and the ones ending in it, such as `openrouter/openai/gpt-4o`, and `gpt-4o` the model at every provider that serves it under that name. These prices win over the model registry for run costs, cost-routing budgets, `estimateCost()`, Tree of Thoughts and `decide()`, and `Cogitator.pricer` exposes them.

  A call whose provider reports no cost and whose model has no price used to count as $0 without a word. It still counts as $0, and the runtime now warns once per model, naming the `llm.pricing` key that fixes it. Ollama and vLLM run on your own hardware, so their calls are free unless `llm.pricing` prices them, even when a reseller lists a model of the same name, and stay quiet. A call is priced by the provider it routes to, under the name it is registered by (`llm.backends.vllm` prices as `vllm/...`), and a model string without a provider by the provider it runs on, `cog.pricedModel(model)` says which.

  An Ollama or vLLM backend you register under a name of your own (`llm.backends.gpu2`) is free the same way.

  A catalogue model listed without a price is no longer priced at $0: it keeps its context window and capabilities, carries `priceUnknown: true`, and the price lookups answer `null`, so its calls warn like any model without a price. A listing with a price wins over one without when a name matches several, automatic model selection skips cloud models without a price, and file caches written by earlier versions are fetched again (offline, an older cache gives way to the bundled copy).

  `@cogitator-ai/models` ships a trimmed copy of the LiteLLM catalogue with its MIT notice (`LITELLM_SNAPSHOT`), the priced text and embedding models at a pinned LiteLLM commit named in `source`. The registry prices models from it when it can neither fetch the catalogue nor read its cache, and for lookups made before `initializeModels()`, where it used to know only the built-in models. Refresh it with `pnpm --filter @cogitator-ai/models snapshot`. `ModelPricer` prices by overrides of your own over the registry and `costOf` prices usage at a given `ModelPricing`.

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - OpenAI-compatible servers get only the request fields they understand. A server profile says which field takes the output token limit, whether streams ask for usage with `stream_options` and which `reasoning_effort` values the server takes. Set it with `profile` on `llm.providers.openai` or `llm.providers.vllm`, by preset name (`openai`, `generic`, `vllm`, `ollama`, `lmstudio`, `llamacpp`, `groq`, `together`, `deepseek`, `mistral`, `openrouter`) or field by field over a preset. An effort the server does not take is sent as the nearest one it does.

  The built-in providers use their own preset. Mistral rejects fields it does not know, so it no longer gets `stream_options` (its streams failed with 422) or efforts beyond `high`. DeepSeek gets `none`, `low`, `high` or `max`, Together `low`, `medium` or `high` and no `stream_options`, Groq `max_completion_tokens`. A server without a preset keeps the request it got before. The Responses API path of the official OpenAI provider follows the profile's `reasoningEffort` too.

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - Anthropic and Google take `baseUrl` and `headers`, for a gateway or proxy in front of the provider: `llm.providers.anthropic.baseUrl` (or `ANTHROPIC_BASE_URL`, `COGITATOR_ANTHROPIC_BASE_URL`) and `llm.providers.google.baseUrl` (or `COGITATOR_GOOGLE_BASE_URL`), the Gemini one with its API version, `https://generativelanguage.googleapis.com/v1beta` by default. `headers` also works for `openai`, `openrouter` (for example OpenRouter's `HTTP-Referer` and `X-Title`) and `vllm`, and Bedrock takes an `endpoint` for VPC endpoints and proxies.

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - LLM errors are classified by the provider's own error codes, not by the HTTP status alone. Every `LLMError` carries `kind` (also as `details.kind`): `rate_limit`, `quota`, `authentication`, `permission`, `not_found`, `invalid_request`, `context_overflow`, `content_filter`, `overloaded`, `server_error`, `timeout`, `network` or `invalid_response`. The tables read OpenAI and OpenAI-compatible servers by `error.code` and `type`, Anthropic by `error.type`, Gemini by its status and the quota that ran out, Bedrock by the exception name. Errors a provider sends inside a stream that already began are classified the same way. `classifyProviderError` is exported for backends of your own.

  New `ErrorCode.LLM_QUOTA_EXCEEDED` for an account out of credits or over a quota that waiting a moment will not lift: OpenAI's `insufficient_quota`, `credit_balance_exhausted` and spend or usage limits, a 402 from OpenRouter and other OpenAI-compatible servers, Anthropic's `billing_error`, a balance too low and a reached usage limit, a Gemini quota counted per day or prepaid credits that ran out, Bedrock's `ServiceQuotaExceededException`. These are never retried, and server adapters answer them with HTTP 402, which clients do not retry either.

  An error with a numeric `code` inside a stream, as OpenRouter reports the failure of the model's own provider, is read as that HTTP status, and a Gemini error passed on by an OpenAI-compatible endpoint or proxy is read by Gemini's rules.

  A call the caller aborts fails with the reason the caller aborted with (`signal.reason`), on every built-in backend, not with a retryable provider error a retry or fallback layer would act on. The OpenAI and Bedrock SDKs end a stream quietly when it is aborted, so a cut-off answer used to pass for a whole one. `abortReason(signal)` is exported.

  Migration:

  - A 429 for exhausted credits or a spend cap was `LLM_RATE_LIMITED` and retried. It is now `LLM_QUOTA_EXCEEDED`, not retryable. Code that waits and retries on `LLM_RATE_LIMITED` keeps working for real rate limits.
  - A 504 from a provider was `LLM_UNAVAILABLE`, it is now `LLM_TIMEOUT` (still retryable). A 408 was `LLM_INVALID_RESPONSE` and not retried, it is now `LLM_TIMEOUT` and retried.
  - A 402 was `LLM_INVALID_RESPONSE`, it is now `LLM_QUOTA_EXCEEDED`. A 413 or 422 was `LLM_INVALID_RESPONSE`, it is now `VALIDATION_ERROR` (or `LLM_CONTEXT_LENGTH_EXCEEDED` when the provider says the prompt is too long).
  - An Anthropic 400 about a credit balance too low or a reached usage limit was `VALIDATION_ERROR`, it is now `LLM_QUOTA_EXCEEDED`. A Gemini 400 `FAILED_PRECONDITION` (no free tier in the region and no billing) was `VALIDATION_ERROR`, it is now `LLM_UNAVAILABLE` with `kind: 'permission'`.
  - A prompt Gemini blocks was `LLM_INVALID_RESPONSE`, it is now `LLM_CONTENT_FILTERED`.
  - An aborted call rejects with the abort reason. Check `signal.aborted` or the error you aborted with, not `LLMError`.
  - A 403 is reported as `Permission denied (403)` instead of `Authentication failed (403)`, a 503 or 529 as `Provider overloaded`, both with the same code as before.

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/sandbox@0.5.16

## 0.39.1

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/models@18.4.1
  - @cogitator-ai/sandbox@0.5.15
  - @cogitator-ai/types@0.41.1

## 0.39.0

### Minor Changes

- [#183](https://github.com/cogitator-ai/Cogitator-AI/pull/183) [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619) - A run that fails still reports what it spent.

  - `onRunError`, of run options and of run observers, gets a third argument: the tokens and cost of every model call that finished (`RunUsage`, the shape of `RunResult.usage`). A run cut short by its timeout or an abort used to report nothing, though its calls were paid for.
  - A `RUN_TIMEOUT` error carries the same in `details.usage`.
  - Each `llm.chat` span carries its call's cost in `llm.cost`, so a tracer sees spending call by call.
  - The Langfuse exporter keeps the usage of a failed run in its trace metadata, and decision runs pass theirs to `onRunError` too.

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/memory@0.12.5
  - @cogitator-ai/sandbox@0.5.14

## 0.38.0

### Minor Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Decision models and OpenRouter as a built-in provider.

  - `cog.decide()` asks a decision model typed questions about a state and returns typed answers with probabilities instead of text: `noul` for yes or no, `choice` for one of several options, `score` for a level on a scale. Answers are typed by the questions, the request is checked before the call and the answer after it, and the call goes through the LLM retry policy, is checked against cost-routing budgets before it is sent, goes through `security.pii` masking or blocking, is priced and is reported to run observers as a run with one `llm.decide` span.
  - `decisionTool()` turns fixed questions into a tool an agent passes the state to.
  - OpenRouter's Decisions API is built in, with TypeSafe's Jev (`openrouter/typesafe/jev-1.13`). Other providers plug in through `llm.decisionBackends` and the `DecisionBackend` interface.
  - OpenRouter is a built-in provider for chat too: `llm.providers.openrouter` with `apiKey` and an optional `baseUrl`, or `OPENROUTER_API_KEY` through `@cogitator-ai/config`.
  - A chat run on a decision model fails at once with `CONFIGURATION_ERROR` instead of a provider error.
  - `LLMRetryPolicy` and `retryLLMCall` give calls that are not chat the retry policy of LLM backends.
  - `@cogitator-ai/models` knows Jev with its price, marks models with `kind: 'chat' | 'decision'` and adds `isDecisionModel()`.
  - Studio shows `llm.decide` spans.

  **Breaking:** a model string starting with `openrouter/` now runs on the OpenRouter provider. Before, the prefix stayed part of the model name on `llm.defaultProvider`.

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/memory@0.12.4
  - @cogitator-ai/sandbox@0.5.13

## 0.37.0

### Minor Changes

- [#149](https://github.com/cogitator-ai/Cogitator-AI/pull/149) [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e) - A tool call whose arguments are not valid JSON no longer fails the run. When a finished turn carries arguments a provider broke, or arguments that are not a JSON object, the call keeps empty `arguments` with the reason in the new `ToolCall.argumentsError`. The runtime does not run it or ask for its approval, and gives the model `Invalid arguments: ...` as the call's result, as it does for arguments that miss the tool's schema, so the model calls again. Before, the run failed with `LLM_INVALID_RESPONSE`. A call cut off at the token limit is still never run. `toolCallArguments()` reads arguments this way for backends of your own, and `parseToolCallArguments()` still throws.

- [#149](https://github.com/cogitator-ai/Cogitator-AI/pull/149) [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e) - A model call that hangs no longer eats the whole run. `llm.retry.requestTimeout` sets how long one call may take: a call with no answer by then is aborted and retried like a dropped connection, as a retryable `LLM_TIMEOUT`, and a stream gets that long for each chunk (a stream that stalls after its first chunk fails, as any broken stream does). Before, a request the provider never answered waited for the SDK's own timeout, ten minutes for OpenAI-compatible servers, so a run with a shorter `timeout` failed without a retry while other calls to the same model answered in seconds. It is off by default, and YAML configs take it as `llm.retry.requestTimeout`.

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/memory@0.12.3
  - @cogitator-ai/sandbox@0.5.12

## 0.36.0

### Minor Changes

- [#144](https://github.com/cogitator-ai/Cogitator-AI/pull/144) [`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198) - Prompt caching for Claude shares the system prompt between runs and reaches Claude through OpenRouter.

  Anthropic requests now mark the end of the agent's instructions at the start of the system prompt, so runs with different input, such as single-turn runs that share only their instructions, read those from the cache instead of writing them again. The top-level mark on the end of the conversation is set only when another turn is likely (the request offers tools or continues earlier turns), since a single turn with unique input only paid the cache write premium on it. `llm.promptCache.conversation` overrides that choice, and `ChatRequest.cachePrefix` names the stable start of a request's system prompt.

  An `OpenAIBackend` for OpenRouter (`provider: 'openrouter'` or an `openrouter.ai` base URL) marks `anthropic/*` models the same way, where before it sent no marks and Claude never cached. Its usage reports OpenRouter's `cache_write_tokens` as `cacheWriteTokens`. Other OpenAI-compatible servers and models are left unmarked.

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/memory@0.12.2
  - @cogitator-ai/sandbox@0.5.11

## 0.35.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - - `cogitator.observe(observer)` attaches a run observer to a runtime after it was built, also seeing the runs that agent tools start on it; `CogitatorConfig.observers` and the `observer()` of the OpenTelemetry and Langfuse exporters watch every run and flush on `close()`.
  - The package ships its documentation as Markdown in `docs/`, the docs of exactly the installed version, starting at `docs/index.md`.
  - `restrictFileTools` and `isPathAllowed` (moved from channels) confine the file tools to directories, with `base` and `requireApproval` options.
  - The Langfuse exporter marks the trace of a failed run as an error, ends what was still open as ERROR and drops the run, which it kept forever before.
  - A time-travel fork with both a new input and extra context applies both, it ran with the original input before.
  - Time-travel checkpoints count only a run's own tool calls as steps: a run that continued a thread forked from the wrong turn before.

  **Breaking:** a time-travel step is the index of a tool call of the run itself. Checkpoints of runs on a thread with earlier tool calls now have smaller step numbers, and a step past the last tool call forks before the final answer. Code that stored step numbers of such runs needs to read them again from `getCheckpoints()`.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/sandbox@0.5.10

## 0.34.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Agents travel to other processes in one complete wire format. `toAgentWire(agent)` and `fromAgentWire(payload, { cogitator, tools })` in `@cogitator-ai/core` carry every `AgentConfig` field (stop sequences, timeout, handoff graphs, the response schema as JSON Schema and the rest) and route the model exactly as the sender would, and `toAgentWireRunResult` / `fromAgentWireRunResult` carry a run's outcome with its cost, duration and the `truncated`, `blocked` and `iterationLimitReached` flags. Worker agent, workflow and swarm jobs (`serializeAgent`, `SerializedAgent`) and distributed swarm turns now use them, which fixes several silent losses:

  - an agent with an explicit `provider` (`{ model: 'openai/gpt-5', provider: 'openrouter' }`) ran on a different provider after `serializeAgent`
  - `timeout`, `stopSequences` and `handoffs` were dropped by `serializeAgent`, so a long job failed at 120 s and a triage agent answered itself
  - agent nodes of worker workflow jobs dropped `responseFormat`, `topP` and `reasoning`, and now write the structured answer of a JSON schema agent to the state
  - distributed swarm turns dropped `responseFormat`, `reasoning`, `topP` and `onIterationLimit`, and reported cost 0 without `truncated`, so `resources.costLimit` never stopped a swarm and the debate retry of a reasoning-starved turn never ran

  A config with a key the receiving side does not know is now refused instead of run without that setting.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `onApproval` may return `undefined` to leave a call to `guardrails.onToolApproval` (and, without it, to pause the run), so a run can decide some calls itself and keep the configured policy for the rest. Tools also get the id of the call they execute as `context.toolCallId`, in runs and in `cogitator.invokeTool()`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Filtered and refused answers are visible on the result. `RunResult.blocked` is `'content_filter'` when the provider's safety system withheld the answer (OpenAI and Azure content filters, Gemini `SAFETY` and similar, Bedrock guardrails) and `'refusal'` when the model declined (OpenAI and Anthropic refusals, with the explanation in `output`). Before, such a run ended `completed` with an empty output after asking the model twice more. `ChatResponse.finishReason` gains `'content_filter'` and `'refusal'` (the new `FinishReason` type), and `normalizeTurn()` is exported for backends of your own.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Tools can return media with `toolContent(...parts)`: text and image parts reach the model as the content of the tool message (images as image parts), and file parts such as audio stay with the result for the application while the model sees a one-line description. Guardrails that filter tool results read the text and the descriptions instead of base64 data. `toolResultParts()` reads the parts of any result, including objects with a base64 `image` as before.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A run that paused for tool approvals now keeps its pause wherever it goes, and tools can run outside a run the way a run executes them.

  - The run result wire format (`toAgentWireRunResult` / `fromAgentWireRunResult`, used by queue jobs and distributed swarm turns) carries `status`, `pendingApprovals` and the `checkpoint`. Before, a paused run arrived as a completed one whose output was the model's text before the tool call, and nothing could resume it.
  - `isPausedRun(result)` tells a paused run from an answer, and `AgentRunPausedError` (code `RUN_PAUSED`, HTTP 409) reports a pause where the caller cannot wait, with the calls that wait and the checkpoint to resume from. `findAgentRunPausedError` finds it behind wrapping errors.
  - `cogitator.invokeTool(tool, args, options)` runs one tool call with schema validation, approval (`onApproval`, else `guardrails.onToolApproval`, else the call is refused with `pendingApproval`), the guardrails, the runtime's sandbox and `tool.timeout`. `Cogitator` implements the new `ToolInvoker` interface from `@cogitator-ai/types`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Tool parameter schemas reach every provider self-contained. A recursive Zod schema (`z.lazy()`) used to arrive with a `$ref` to a definition the request no longer carried. Now the definitions recursive refs point to travel in `parameters.$defs` (`ToolSchema.parameters` is typed as `ToolParametersSchema`, a JSON Schema object with optional `$defs`), refs to other definitions are inlined, and Google gets recursive schemas as `parametersJsonSchema`. `ToolRegistry.getSchemas()` sends each tool's own `toJSON()`, so tools that carry a JSON Schema (MCP, AI SDK) keep it, and `registerMany` warns when two different tools in one list share a name. The new `toToolParameters()` applies the same rules to any JSON Schema. WASM tools keep their definitions too.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `RunOptions.toolChoice` sets which tools the model may or must call in a run. `'none'` holds for every turn. `'required'` or a named function forces a call on each turn until the model makes one, then the run goes back to `'auto'`, so the model answers from the results instead of calling tools until `maxIterations`. A named function the agent does not have fails the run with `VALIDATION_ERROR`.

  The OpenAI-compatible endpoints pass `tool_choice: 'required'` and a named function on to the run, where before they only narrowed the tools and a model could still answer in plain text. The AI SDK bridge forces `required` and a named tool of the agent the same way instead of warning that it cannot.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Prompt-cache writes with Anthropic's 1-hour TTL are priced at their own rate. With `llm.promptCache: { ttl: '1h' }` every write was counted at the 5-minute price, 37.5% under what Anthropic bills. `ChatUsage.cacheWrite1hTokens` reports the part of `cacheWriteTokens` written for an hour, `ModelPricing.inputCacheWrite1h` holds its price (read from LiteLLM and set on the built-in Claude models), and `calculateCost()` takes `cacheWrite1hTokens`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Bedrock errors are classified by their AWS exception name and HTTP status instead of words in the message. `ValidationException: Input is too long` was retried twice as an unavailable service, a message containing "separate" matched "rate" and became a rate limit, and `AccessDeniedException` was retried. Now `ThrottlingException` and `ServiceQuotaExceededException` are retryable rate limits, `ValidationException` is a client error (or `LLM_CONTEXT_LENGTH_EXCEEDED` for an overlong input), `AccessDeniedException` is not retried and `ModelTimeoutException` is a retryable `LLM_TIMEOUT`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Bedrock works with temporary AWS credentials again. `loadConfig` no longer copies `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` into `llm.providers.bedrock`, where they replaced the SDK credential chain without the session token and STS, SSO or CI role credentials failed with `UnrecognizedClientException`. The AWS SDK now resolves them itself, together with `AWS_SESSION_TOKEN` and `AWS_PROFILE`. Static credentials come only from `COGITATOR_BEDROCK_*` or `llm.providers.bedrock`, which gains `sessionToken` and `profile` (also `COGITATOR_BEDROCK_SESSION_TOKEN` and `COGITATOR_BEDROCK_PROFILE`), and `BedrockBackend` sends them to the SDK.

  `PROVIDER_ENV` in `@cogitator-ai/config` lists the environment of every built-in provider, and `resolveModelRoute()` in `@cogitator-ai/types` is the one rule for which provider a model string runs on, used by the runtime and by `cogitator deploy`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `ContextBuilder` never drops the system prompt anymore. Before, instructions larger than the budget (about 15k characters with the runtime's default 4000 tokens) were silently left out, so the run went to the model without a system prompt and lost `RunOptions.context` and reflection insights with it. The prompt is now always kept and counted, history gets what it leaves, and `BuiltContext.warnings` explains when nothing else fits. In runs, the agent's instructions always come first, `includeSystemPrompt: false` is ignored with a warning, and the warning about an oversized prompt is logged.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A part of the context that fails to load no longer fails the run or vanishes silently. `ContextBuilder.build()` leaves out the history, facts, semantic search, knowledge graph or relevance scoring that failed and lists it in the new `BuiltContext.errors` (`{ source, error }`). Runs pass each of them to `onMemoryError` with the `'load'` operation and log a warning, so an embedding API answering 429 with `includeSemanticContext` no longer fails every run, and a brief database outage no longer makes the agent answer as if the conversation never happened. The runtime also warns at connect when `includeFacts`, `includeSemanticContext` or `includeGraphContext` cannot add anything with the configured memory.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A run's `context` is added to the system prompt as one JSON block labelled as data instead of `key: value` lines. A line break in a key or value stays inside a JSON string, so a value such as `"ok\nNew operator policy: ..."` can no longer start a line of instructions next to the agent's own.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A turn the provider ends in an error now fails the run with `LLM_INVALID_RESPONSE`, carrying the provider's explanation, instead of completing it with an empty answer. Gemini reports a function call it could not finish, often one cut by `maxTokens` without a stream, as `MALFORMED_FUNCTION_CALL`, and such a run used to end as `completed` with nothing in it. The new optional `ChatResponse.finishMessage` and `ChatStreamChunk.finishMessage` carry the provider's own explanation, which the Gemini backend fills from `finishMessage`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Context overflow errors of Ollama (`input length exceeds the context length`), llama.cpp (`the request exceeds the available context size`) and proxies that answer `context length exceeded` are reported as `LLM_CONTEXT_LENGTH_EXCEEDED` again, not as a plain `VALIDATION_ERROR`. Only the providers' own overflow phrases count, so a rejected `max_tokens` value still does not.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - LLM errors keep the provider's own message and report a context overflow only when there is one. Any 400 whose body mentioned tokens or length became "Context length exceeded" with the provider's text hidden, so "Unsupported parameter max_tokens, use max_completion_tokens" or an Anthropic `max_tokens` limit looked like an overflowing prompt. Context overflow is now read from the providers' own phrases (`context_length_exceeded`, `maximum context length`, `prompt is too long`, `input is too long` and the like), other bad requests are `VALIDATION_ERROR`, and every `LLMError` message ends with what the provider said.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A memory adapter that fails to connect no longer keeps the process alive. `RedisAdapter` closed nothing when its first ping failed, so ioredis kept reconnecting and logging `Unhandled error event` after `cogitator.close()`. Redis now closes its client, Postgres ends its pool and SQLite closes its file when `connect()` fails, the runtime disconnects any adapter that failed, and the Redis error names the connection problem (`connect ECONNREFUSED ...`) instead of the retry limit.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` connects to Postgres without pgvector. Before, the `CREATE TABLE ... vector(N)` that followed a failed `CREATE EXTENSION` failed `connect()`, so memory was off entirely even for users who only need threads. Threads, entries and facts now work on any Postgres, embedding operations return a failed result naming the reason, and the new `vectorStatus()` tells whether vectors are usable. The runtime does not use such a store for semantic context and logs why.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The README no longer repeats itself: the robots.txt paragraph had the whole document pasted into the middle of its sentence about `*` and `$` patterns, so the core README carried most of its text twice and the rag README its first sections twice. The paragraph reads as written again.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Reasoning models get the parameters they accept on Chat Completions too. `azure/gpt-5` with `maxTokens` sent `{ temperature: 0.7, max_tokens: 500 }` and Azure rejected every call, and `openai/gpt-5` with stop sequences or `api: 'chat-completions'` sent the agent's default temperature. Reasoning models (o-series, GPT-5 and later) now get no `temperature` / `top_p` and their limit as `max_completion_tokens`. Azure tells them by the deployment name or by the new `providers.azure.model` when the name is your own, and its default `apiVersion` is now `2025-04-01-preview`, the first that serves these models.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `initializeModels()` loads the full model catalogue even after a price lookup ran first. A lookup before it loaded the built-in models and marked the registry initialized, so a later `initializeModels()` did nothing, models outside the built-in list (DeepSeek, Groq, Mistral, Together, Bedrock and more) stayed unpriced, their runs reported `usage.cost: 0` and a cost-routing budget never counted them. Overlapping `initialize()` calls now share one load, and with a `budget` configured the runtime warns once per model whose calls it cannot price.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A streamed run with the Constitutional AI output filter on no longer shows the model's text before the filter checked it. The runtime holds back the tokens of each turn and hands `onToken` the checked text in one chunk: the answer when it passes, the revision when the critique-revise loop rewrote it, and nothing when it is blocked. Every server adapter streams through `onToken`, so SSE, WebSocket, A2A and openai-compat clients never see blocked text that the memory then replaces with a revision.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Tool calls now run whatever finish reason the provider reports for them. vLLM, LM Studio, the Gemini OpenAI endpoint and OpenAI with a forced tool answer tool calls with `finish_reason: 'stop'`, and a run on them used to end with an empty `completed` result without calling the tool. Every built-in backend now settles a turn the same way, and the runtime applies the same rule to backends of your own.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A tool call cut off at the token limit never runs. A streamed Anthropic or Bedrock turn that hit `max_tokens` in the middle of a `tool_use` ran the tool with `{}`, so a tool whose parameters are all optional ran with its defaults. Such a turn now ends the run with `truncated: true` on every backend, streamed or not, and the cut-off call is not kept in the thread. A finished turn whose streamed tool arguments are not valid JSON fails with `LLM_INVALID_RESPONSE`, as it already did without streaming.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - A WASM tool run that traps or panics, times out, or writes more than the sandbox keeps now comes back as a tool error with the reason, instead of an empty successful result the model would guess around. `SandboxExecutionResult` has a new `truncated` flag the WASM executor sets when it cuts the output.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/models@18.3.0
  - @cogitator-ai/memory@0.12.0
  - @cogitator-ai/sandbox@0.5.9

## 0.33.0

### Minor Changes

- [`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e) - `RunResult.structuredError` says why the final answer does not match the agent's `responseFormat` after the run's one correction, in the words the model was given, such as `the answer is not valid JSON` or `celsius: expected number, received string`. Before, `structured` was simply `undefined` with no reason to read.

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/memory@0.11.8
  - @cogitator-ai/sandbox@0.5.8

## 0.32.0

### Minor Changes

- [#123](https://github.com/cogitator-ai/Cogitator-AI/pull/123) [`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774) - A debate turn of a reasoning model no longer comes back empty under a short `maxTokensPerTurn`. Providers count reasoning in the same output limit as the answer, so a model that reasoned past the limit returned an empty or cut-off turn. Now a turn the model spent thinking, its answer stopped at the limit or came back empty after reasoning with less than half the limit in visible text, is run once more with room to reason on top: 4096 tokens or twice what it reasoned. The check works on every provider, including those that report no reasoning tokens. A model that does not reason keeps the limit as it is, and a turn that called tools is never run again. The new `DebateConfig.reasoningTokensPerTurn` gives the room from the first try; debaters are asked to keep their answer to `maxTokensPerTurn`, since providers cannot cap the answer apart from the reasoning.

  `RunResult.truncated` is `true` when the model's last answer stopped at the output token limit.

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/memory@0.11.7
  - @cogitator-ai/sandbox@0.5.7

## 0.31.0

### Minor Changes

- [#121](https://github.com/cogitator-ai/Cogitator-AI/pull/121) [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006) - `web_scrape`, `http_request` and the `transcribe_audio` tool reach only public hosts. A model chooses their URLs, so a page or a prompt could point them at a cloud's metadata endpoint, `localhost` or a service on the internal network. A loopback, private, link-local, carrier-grade NAT, multicast or documentation address, `localhost`, `*.local`, `*.internal` or a metadata host is now refused, every redirect target is checked, and a hostname is checked by the address it resolves to when the request connects, which also stops DNS rebinding. A refused URL comes back to the model as an `error`. With a robots.txt checker, `web_scrape` checks a URL and the addresses its host resolves to before the checker reads robots.txt, and `RobotsPolicy` takes `fetch: fetchPublic` to keep those reads on public hosts too.

  To reach a trusted network, pass `allowPrivateNetwork: true` to `createWebScrapeTool`, `createHttpRequestTool` (new) or `createTranscribeAudioTool`, or give them a `fetch` of your own. The guard is exported for your code too: `fetchPublic`, `createPublicFetch`, `assertPublicUrl`, `assertPublicHost`, `isPrivateAddress`, `createGuardedLookup`, `PrivateNetworkError` and `DEFAULT_USER_AGENT`, on `node:http` in Node and Bun alike. Its requests carry a User-Agent and `Accept: */*` unless the caller sets its own. `fetchAudioAsBuffer`, `audioInputToBuffer` and `transcribeAudio` take a `fetch` option and keep the global `fetch` by default.

### Patch Changes

- [#122](https://github.com/cogitator-ai/Cogitator-AI/pull/122) [`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2) - Cost-routing budgets hold against what runs really spend. Before, a run was checked once against an estimate of its cost and recorded once it completed, so a run with many tool calls could spend far past `maxCostPerRun`, a failed or cancelled run never counted toward the hourly and daily budget, and runs side by side did not see each other's spending. Now the runtime also checks before every model call: the run's real cost so far against `maxCostPerRun`, and every run's recorded spending against `maxCostPerHour` and `maxCostPerDay`. A run that reaches a limit stops with `BUDGET_EXCEEDED`. Each call's cost is recorded as soon as it is answered, and a budget keeps its records even with `trackCosts: false`. `CostAwareRouter.checkSpent(runCost)` and `BudgetEnforcer.checkSpent(runCost)` expose the check.

  A run that hands off to another model now counts each call at the price of the model that answered it, where the tokens of every call without a reported cost were priced on the model active at the end. That fixes `usage.cost` of such runs, and keeps a handoff to a cheaper model from slipping past `maxCostPerRun`. The checkpoint of a paused run keeps those tokens by model in `RunCostState.unreportedByModel`; a checkpoint saved before prices its tokens on the run's model, as it did.

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/memory@0.11.6
  - @cogitator-ai/sandbox@0.5.6

## 0.30.4

### Patch Changes

- [#120](https://github.com/cogitator-ai/Cogitator-AI/pull/120) [`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b) - `web_scrape` renders Markdown in linear time. Each link rebuilt the whole Markdown string written so far to wrap its text, so a page of many links took time quadratic in its length: 40,000 unclosed headings with links took about 750 ms instead of 45. The Markdown is now kept in parts and a link rewrites only its own.

## 0.30.3

### Patch Changes

- [#118](https://github.com/cogitator-ai/Cogitator-AI/pull/118) [`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a) - OpenAI-compatible backends read the error a router such as OpenRouter sends in place of an answer: `{ error: { code, message } }` in the body of a successful response, or in an event of a stream, which the OpenAI SDK raises as an `APIError` without a status while the stream is read. Both now become an `LLMError` by the code they carry, so a rate limit or a provider failure is retryable, where before the backend crashed on `response.choices[0]` with a `TypeError`, or let the SDK's status-less error through, and nothing retried either. A response without choices is an invalid response, and a stream chunk without them is skipped. `providerErrorIn(body, context, cause?)` is exported for custom backends.

## 0.30.2

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/models@18.2.1
  - @cogitator-ai/sandbox@0.5.5
  - @cogitator-ai/types@0.33.1

## 0.30.1

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/memory@0.11.4
  - @cogitator-ai/sandbox@0.5.4

## 0.30.0

### Minor Changes

- [#112](https://github.com/cogitator-ai/Cogitator-AI/pull/112) [`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80) - A run whose tool calls use up `maxIterations` now ends with an answer. Until now the loop stopped at the last tool turn, so the output was empty and `structured` was undefined for an agent with a response format, with nothing telling the caller why. The run now gets one more turn with `toolChoice: 'none'` and an instruction to answer from what it has, and tools the model still asks for on that turn are not run. `RunResult.iterationLimitReached` is set whenever the limit is hit, and `onIterationLimit: 'stop'` on the agent keeps the old behaviour. The option survives `serialize` and `deserialize`.

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/memory@0.11.3
  - @cogitator-ai/sandbox@0.5.3

## 0.29.0

### Minor Changes

- [#111](https://github.com/cogitator-ai/Cogitator-AI/pull/111) [`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8) - `web_search` gets filters that work on every provider: `topic` (`general` or `news`), `recency` (`day`, `week`, `month`, `year`) or a `dateRange`, `includeDomains` and `excludeDomains`, `country`, `language` and `page`. Each maps to the provider's own parameters (Tavily's request fields, the news endpoints and query parameters of Brave and Serper), with `site:` operators where a provider has no domain parameter. A filter a provider cannot apply comes back as an error instead of being dropped. Tavily also takes `includeRawContent` and the `fast` and `ultra-fast` search depths. Results carry `publishedAt` in ISO 8601 when the provider reports a date, `source` for Serper news and `content` for raw page content. `createWebSearchTool({ provider, apiKeys })` builds the tool with a default provider and keys passed in code.

## 0.28.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Agents can crawl politely. Nothing in Cogitator looked at robots.txt, so every app that read the web had to write its own check. `RobotsPolicy` in core reads and caches robots.txt per site by RFC 9309 (product token groups or `*`, longest match, `*` and `$` patterns, a 4xx file allows all, a 5xx or a network failure allows nothing until the cache expires) and implements the new `RobotsChecker` interface from types. `WebLoader` takes it as `robots` and checks every hop, redirect targets included, failing with `RobotsDisallowedError` before any request. `BrowserSession` takes it as `robots` and blocks disallowed navigations, typed, clicked, redirected or in frames, while `newTab(url)` and `browser_navigate` say why. `createWebScrapeTool({ userAgent, robots })` builds a `web_scrape` tool that checks every hop, redirects included.

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - A streamed run with only `onReasoning` now streams. The runtime streamed only when `onToken` was passed, so a caller that wanted the reasoning as it arrives, and not the answer tokens, got it all at the end in `result.reasoning`. `stream: true` with either callback streams now.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/sandbox@0.5.2

## 0.27.0

### Minor Changes

- [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe) - New `cog.knowsProvider(name)` tells whether a `name/...` model prefix routes to that provider: a backend in `llm.backends`, a built-in provider or a registered plugin. It is the check `cog.route()` uses, so code that hands a model string to another process (such as `@cogitator-ai/worker`) can tell a provider prefix from a model name that merely contains a slash, like `meta-llama/llama-4-scout`.

- [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2) - `RunResult.usage.cost` uses what the provider charged when it says so. OpenAI-compatible services that add the call's price to `usage` (OpenRouter does, as `usage.cost`) now pass it on as `ChatUsage.cost`, and the runtime adds those prices up instead of estimating them, so runs on models the model registry does not list (for example DeepSeek or Qwen through OpenRouter) no longer report a cost of 0. Calls without a reported price are priced from the registry as before, now with the full model string (`openrouter/deepseek/deepseek-v4-pro`) so the registry can pick that provider's listing. The cost so far is kept in run checkpoints, so a paused and resumed run adds to it. Thought trees and cost estimates use the same rules.

### Patch Changes

- [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7) - Structured output with tools now works on OpenAI-compatible servers other than OpenAI. When an agent has both tools and a `responseFormat`, requests to such servers (OpenRouter, DeepSeek, Groq, Together, Mistral, vLLM or an `OpenAIBackend` with a custom `baseUrl`) carry the JSON schema as a system-prompt instruction instead of `response_format`. Many of these providers enforced `response_format` from the first turn, so the model answered in JSON without calling its tools, or ignored the schema: through OpenRouter, DeepSeek V4 Pro called the tool in 1 of 5 runs and matched the schema in none, and Qwen 3.8 Flash never matched it. With the schema in the prompt all tested models (DeepSeek, GPT-6 Luna, Qwen, MiMo, GLM) called the tool and matched the schema every time. The official OpenAI API and Azure OpenAI, and every request without tools, still use `response_format`.

- [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57) - `LangfuseExporter.flush()` and `shutdown()` now wait until Langfuse has received the queued events. They called the Langfuse client's `flush()` and `shutdown()`, which return immediately without waiting, so traces sent just before a process exited could be lost. They now await `flushAsync()` and `shutdownAsync()`. A hand-written type declaration for `langfuse` hid the difference, and it is gone together with the ones for `nodemailer` and `better-sqlite3`: the exporter, the `send_email` tool and the `sql_query` tool are now checked against the real packages' types. Generations no longer send unset `temperature` or `maxTokens` as `undefined` model parameters.

- [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9) - Memory failures are no longer dropped silently. Adapters report most failures as a failed `MemoryResult` rather than by throwing, and the runtime only caught throws, so a history entry the store refused (for example every tool call turn on Postgres) was lost without a warning and `onMemoryError` was never called. Failed `addEntry`, `getThread`, `createThread` and history `getEntries` results are now logged and passed to `onMemoryError` (`'save'` or `'load'`), and the run still goes on, as documented.

- [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7) - `OpenAIBackend` accepts any provider name, not only the built-in ones, so an OpenAI-compatible service registered as a custom backend reports its own name in errors and traces: `new OpenAIBackend({ apiKey, baseUrl: 'https://openrouter.ai/api/v1', provider: 'openrouter' })` now compiles and its errors say `openrouter` instead of `openai`.
- Updated dependencies [[`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`e150c83`](https://github.com/cogitator-ai/Cogitator-AI/commit/e150c83e8c9dc1bd9961d0a3413cf31d0d9175f1)]:
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/models@18.2.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/sandbox@0.5.1

## 0.26.2

### Patch Changes

- [`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41) - The optional `nodemailer` peer dependency of the `send_email` tool now accepts versions 6 through 10 instead of only 6. nodemailer 6 has known vulnerabilities that are fixed only in newer majors, and the old range made a fixed version a peer-dependency conflict. The tool uses only `createTransport` and `sendMail`, which are unchanged across these versions.

## 0.26.1

### Patch Changes

- 9a7b6f4: A run no longer ends on an empty turn. When the model stops with neither text nor tool calls — Gemini occasionally does this right after a tool result — the run asks again, up to twice, instead of returning an empty answer (and, for structured output, an `undefined` `structured`). The empty turn is never added to the conversation or saved to the thread, and the retries count towards `maxIterations`. Turns cut off by the token limit are not retried.

## 0.26.0

### Minor Changes

- 9175c69: `AutoOptimizer` A/B tests now get samples for both variants: traces carry the instructions version or A/B variant the run used (`ExecutionTrace.prompt`, from `RunResult.prompt`), runs served through `cogitator.prompts` are no longer counted again (all as control), and a test Cogitator completed finishes the optimization run. `ABTestingFramework` reads the active test from its store instead of a per-instance cache. `triggerOptimization()` fails with a clear error instead of optimizing empty instructions when the agent has no deployed version.
- 1993d56: Cost routing budgets (`costRouting.budget`) are enforced on every run, not only with `autoSelectModel`: the run is checked against an estimate for the agent's own model. `autoSelectModel` now picks only models of providers the runtime can call (configured in `llm.providers`, `llm.backends`, a plugin, `llm.defaultProvider` or the agent's own provider) and keeps the agent's model when none fits. New `CostAwareRouter.recommendAvailableModel()` and `checkRunBudget()`.
- 1993d56: `CogitatorConfig.logging` is applied: a runtime created with it sets the process-wide logger (`getLogger()`) to its `level` (now including `'silent'`), `format` and `destination` (`'file'` appends JSON lines to `filePath`). New `createLoggerFromConfig()` builds such a logger directly.
- 656499e: `createToolCacheStorage()` now accepts `onEvict` and passes it to the memory or Redis storage, so evictions of a storage built with it can be observed. A `keyPrefix` (or `generateCacheKey` prefix) that already ends with `:` no longer produces keys with `::`.
- b8c9eca: A custom backend can report its own provider name: `LLMBackend.provider` (and `BaseLLMBackend.provider`) is now `LLMBackendProvider`, a built-in `LLMProvider` or any other string, so `class MyBackend extends BaseLLMBackend { readonly provider = 'my-llm' }` compiles.
- d35ef2a: `PostgresTraceStore.traces()` adapts the store to a `TraceStore`, so it can back `AgentOptimizer`, `DemoSelector` or `TimeTravel` directly. Traces also persist the run's `prompt` (a `prompt` column is added to existing tables on connect).

### Patch Changes

- e70e482: Counterfactuals now evaluate `custom` structural equations: `customFn` is an arithmetic expression over the parent node ids (numbers, `+ - * / ^`, parentheses, `abs exp log sqrt pow min max tanh sigmoid`), parsed without running code, with additive noise like `linear`. Nodes without an equation keep their observed value instead of a random noise sample.
- 1993d56: `getGuardrails()`, `setConstitution()`, `getCostRouter()` and `getCostSummary()` work before the first run. The guardrails are built from `guardrails.model` or `llm.defaultModel` when one is set; a constitution set earlier is applied when the first run builds them.
- 1369ed1: `Agent.deserialize()` accepts the snapshot of an agent without a model (which runs on `llm.defaultModel`); `validateSnapshot()` used to reject it.
- 0bf2e44: `agentAsTool()` no longer reports a paused inner run as a success with empty output: an `onApproval` that answers `'pause'` declines the call (a delegated run cannot wait for a person), and a run that pauses anyway returns `success: false` with the pending tools.
- bc76f42: `builtinTools` is a `Tool[]`, so `new Agent({ tools: builtinTools })` compiles; the readonly tuple it was could not be assigned to `AgentConfig.tools`.
- 1993d56: Config-driven memory now builds every store `memory.adapter` names: `sqlite` (from `memory.sqlite.path`), `mongodb` (from `memory.mongodb.uri`) and `redis` from `host`/`port` or `cluster` as well as `url`. `memory.qdrant` becomes the embedding store that `memory.contextBuilder` searches, and `adapter: 'qdrant'` explains that Qdrant does not store threads instead of logging "Unknown memory provider". A Postgres store gets the vector size of the `memory.embedding` model instead of always `vector(768)`.
- 1993d56: Deliberate run failures are `CogitatorError`s with a code, so server adapters pass their messages on instead of masking them: a run timeout is `RUN_TIMEOUT` (504, new), a budget stop `BUDGET_EXCEEDED` (429, new), a guardrail-blocked input or output `LLM_CONTENT_FILTERED`, and a missing audio API key, an invalid `limits.maxConcurrentRuns` or a cost estimate without a model `CONFIGURATION_ERROR`. Messages are unchanged.
- 1993d56: Guardrail tool approvals fail closed. In `strictMode`, calls of tools with side effects now go through the run's approval flow (`onApproval`, `guardrails.onToolApproval`, or a paused run) instead of running silently when no `onToolApproval` is set, and `ToolGuard` denies a call that needs approval when no handler can give it.
- c117071: Tool cache fixes: `onEvict` also fires for entries evicted to make room (`maxSize`), not only for `invalidate()`. `RedisClientLike` now matches ioredis 5 and 6 (`scan(cursor, 'MATCH', pattern, 'COUNT', count)`), so an ioredis client can be passed as `redisClient`. A Redis `keyPrefix` without a trailing colon gets one, so `withCache` keys read `toolcache:entry:…` instead of `toolcacheentry:…`.
- 1993d56: Tool results that carry a base64 image (`image` or `imageBase64`, such as browser screenshots and generated images) now reach the model as an image instead of a JSON string full of base64. Anthropic, Bedrock, Google, OpenAI Responses and Ollama attach it to the tool result; OpenAI Chat Completions, which takes only text in tool messages, follows the turn's tool messages with one user message holding the images.
- bc76f42: Tool parameters with a Zod `.default()` are no longer sent to the model as required: tool schemas describe the input side, as the WASM tools already did.
- 656499e: `ThoughtTreeExecutor` ignored `ToTConfig.timeout`; only `explore(..., { timeout })` stopped the search. The configured timeout is now the default, and a timeout passed to `explore()` still takes precedence.
- bc76f42: The `vector_search` tool reads the Ollama endpoint from `OLLAMA_URL` too (after `OLLAMA_BASE_URL`, before `OLLAMA_HOST`), as the config loader does. `sql_query` reads `DATABASE_URL` safely where the environment is not readable.
- b8c9eca: The Google backend converts JSON Schema nulls (a Zod `.nullable()` field, or `null` in a `type` array) into Gemini's `nullable: true`, so structured output with nullable fields no longer fails with HTTP 400.
- 9175c69: `AgentOptimizer` now applies `defaultMetrics`, `customMetrics`, `captureTraces` and `traceRetention` from its learning config, and `MetricEvaluator` evaluates metrics added with `registerMetric()` even when they are not in `config.metrics`. `autoOptimize`, `optimizeAfterRuns` and `traceStore` are marked deprecated: use `AutoOptimizer` and the `traceStore` option instead.
- db2e373: Sandbox fallbacks are explicit and safe. `sandbox.allowNativeFallback: false` refuses to run Docker-sandboxed tools on the host when Docker is unavailable (the fallback stays on by default, with a loud warning). WASM tools no longer fall back to Docker or native execution, which failed with "Command array is empty". Every Docker execution now gets a container no code ran in before (a fresh one is kept warm), so files and processes cannot leak between runs or users; `pool.reuseContainers: true` restores reuse.
- 49503b9: Time-travel checkpoints are consistent about the tool call they are anchored on: `messages` stop before that call's result, like `toolResults` (and `createFromTrace` no longer includes the pending step's result). `checkpointAll`, `checkpointEvery` and replay step counts count tool calls only, `divergedAt` and `stepsReplayed` use the same numbering, and a live replay keeps the checkpoint's history when its messages have no system message.
- a36cde4: `ThoughtTreeExecutor` now sends its own model calls the routed model name (not the `provider/model` id) on the backend of the agent's provider, honours `explorationStrategy` (`beam` runs level by level, `best-first` follows the best-scored branch, `dfs` goes deep first) and `maxIterationsPerBranch`, keeps candidates beyond `beamWidth` so a failed branch backtracks to the next best one, and counts the tokens and cost of branch generation, evaluation and synthesis in `usage` and `stats`.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [bb17767]
- Updated dependencies [9175c69]
- Updated dependencies [e7925d5]
- Updated dependencies [4a2925f]
- Updated dependencies [db2e373]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/sandbox@0.5.0

## 0.25.0

### Minor Changes

- e211b6a: `cog.getMemory()` connects the configured memory adapter on first use, so threads can be read before any agent has run; `cog.memory` stays `undefined` until then. The `/threads` routes of every server adapter use it, so they no longer answer `503 Memory not configured` on a fresh server.
- 7482f93: `toolset(...tools)` returns tools as a typed tuple: still an array an agent accepts, but each element keeps its own parameter and result types, so `const [search] = createMyTools()` calls `search.execute` with search's parameters. `createMemoryTools`, `createSchedulerTools` and the browser's `createNavigationTools`, `createInteractionTools`, `createExtractionTools`, `createVisionTools` and `createNetworkTools` use it; before, their elements were a union whose `execute` accepted nothing.

### Patch Changes

- 452a248: A run whose final answer does not fit its `responseFormat` asks the model once more with the validation problem (for example `celsius: expected number, received string`) instead of returning `structured: undefined` straight away; the rejected answer is not saved to the thread. Streamed runs keep the first answer, since the client has already seen it. JSON wrapped in prose is now read as well.
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/sandbox@0.4.4

## 0.24.0

### Minor Changes

- 0933009: Agents hand conversations over to each other. `handoffs: [billing, support]` (or `{ agent, toolName, description }`) gives an agent `transfer_to_<name>` tools; when the model calls one, the rest of the run goes on as the target agent — instructions, tools, model, reasoning — with the whole conversation. `RunResult.handoffs` and `finalAgent` tell the app which agent answered, `onHandoff` reports each handoff, and a run that pauses for approval after a handoff resumes in the agent it was handed to.
- 0933009: Personal data stays away from the model provider. `security.pii` replaces emails, phone numbers, card numbers (Luhn-checked), IBANs (mod-97), SSNs, IP addresses, API keys and your own patterns with placeholders such as `[EMAIL_1]` in every LLM request. In `mask` mode the answer, its stream and tool call arguments get the real values back, so tools still act on the real address; `redact` keeps the placeholders everywhere, and `block` rejects such input with `PII_DETECTED`. `onDetect` receives counts per kind for audit logs, never the values. `PiiMasker`, `PiiVault` and `withPiiMasking` are exported for use outside a run, and YAML config accepts custom patterns as strings.
- 0933009: Agent instructions get versions you can deploy, roll back and A/B test without redeploying code. `cog.prompts.deploy(agent, instructions)` makes every following run of that agent use the new version, `rollbackTo` brings the previous one back, and each version records its run count, success rate, score, latency and cost. `startABTest` splits threads between the current instructions and a treatment — a thread keeps its variant for the whole test — completes on a significant difference (Welch's t-test) and with `autoDeployWinner` deploys the winner. `RunResult.prompt` says which version and variant ran; `prompts.score` scores runs your way. Versions and tests live in memory by default, or in Postgres via `PostgresTraceStore.instructionVersions()` / `abTests()`.
- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

- 7bee3ef: Runs pause for a person to approve sensitive tool calls and continue later.

  - A tool with `requiresApproval` never runs without a decision. `RunOptions.onApproval` (or `guardrails.onToolApproval`) decides inline; otherwise the run pauses before executing the turn and returns `status: 'paused'`, `pendingApprovals` and a JSON `checkpoint`. `cogitator.resume(agent, threadId | checkpoint, { decisions, defaultDecision, userId })` executes the approved calls, answers declined ones with the reason, and goes on. A new message on the thread instead declines the waiting calls.
  - Paused runs are kept per thread in the memory adapter's thread metadata (`ThreadRunCheckpointStore`), in process memory without memory (`InMemoryRunCheckpointStore`), or in `runCheckpoints`. Resuming by thread checks the caller (`THREAD_ACCESS_DENIED`); a thread with nothing paused answers the new `RUN_NOT_PAUSED` (409).
  - `agentAsTool` passes the caller's `userId` to the delegated run and declines its approvals unless given `onApproval`, instead of reporting a paused sub-run as success.
  - Server adapters answer paused runs with `status` / `pendingApprovals` (never the checkpoint), stream `approval-required`, and take `POST /agents/:name/resume` (plus a WebSocket `resume` message); Next.js has `createResumeHandler` and `pendingApprovals` / `approve()` / `deny()` in its hooks; channels ask in the chat and resume on "approve" / "deny <reason>" (also "да" / "нет").

  **Behaviour change:** `requiresApproval` used to be enforced only with constitutional guardrails and an `onToolApproval` callback; without them such tools ran unasked. They now pause the run. WebSocket `complete` events no longer include a paused run's checkpoint.

### Patch Changes

- a7cb81b: Cogitator runs on Cloudflare Workers and on Deno without extra permissions. Agents no longer draw a random id in their constructor — it is generated on first read — so they can be created at module scope, where Workers forbid random values. The runtime, logger and built-in tools read environment variables through a guard, and only when a feature needs them: a run no longer asks for `OPENAI_API_KEY` unless it has audio, and runtimes without `process` or with env access denied get `undefined` instead of an error. The model price cache in `@cogitator-ai/models` loads the file system lazily and stays in memory where there is none, so importing it no longer reads the home directory. `validateSkill` checks dependencies through `process.getBuiltinModule` and warns where packages cannot be resolved.
- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/models@18.1.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/memory@0.9.1
  - @cogitator-ai/sandbox@0.4.3

## 0.23.0

### Minor Changes

- 9ff5a06: Agent runs retry failed LLM calls instead of failing on the first 429 or 5xx.

  - New `llm.retry` (`maxRetries` 2, `baseDelay` 1000, `maxDelay` 30000, `maxRetryAfter` 60000, `onRetry`; `false` turns it off) applies to every backend the runtime uses, `llm.backends` and plugins included. Only retryable errors are retried: rate limits, 5xx, timeouts, dropped connections.
  - A provider's wait is honoured: `retry-after`, `retry-after-ms`, an HTTP date or Gemini's `RetryInfo.retryDelay`. A wait longer than `maxRetryAfter` fails the call at once.
  - Streams are retried only before their first chunk; the run's timeout and abort signal stop the waits.
  - `withLLMRetry(backend, config)` / `RetryingBackend` give a standalone backend the same behaviour; `retryAfterFromHeaders` is exported.

  **Behaviour changes:** backends created by `createLLMBackend` no longer retry inside the OpenAI, Anthropic, Azure and Bedrock SDKs (new `maxRetries` backend option, the runtime passes 0), so attempts never multiply — wrap such a backend with `withLLMRetry` when using it on its own. `LLMError.retryAfter` now holds only a wait the provider asked for; it is `undefined` instead of an invented 60 s (429), 5 s (5xx) or 1 s otherwise. `cogitator.route()` returns the retrying wrapper unless `llm.retry` is `false`.

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/sandbox@0.4.2

## 0.22.0

### Minor Changes

- c4a4252: Agents can run on backends of your own. `llm.backends` takes `LLMBackend` instances by name: an agent with model `name/model` or `provider: 'name'` runs on it, and a name of a built-in provider replaces it. Backend plugins registered with `registerLLMBackend()` are now used by the runtime, created on first use with their config from `llm.plugins`; before, the registry was never consulted. A provider nobody provides fails with `CONFIGURATION_ERROR`. `cogitator.route(model)` returns the backend and model name a run uses. With `fromAISDK()`, any AI SDK model now runs Cogitator agents, tools included.
- f134b01: Config keys that did nothing now either work or are gone.

  - `reflection.reflectAfterError` works: a failed tool call gets the error reflection (`ReflectionEngine.reflectOnError`), and its suggestion reaches the next model call.
  - `TimeTravelConfig.maxCheckpointsPerTrace` and `checkpointRetention` are enforced when `TimeTravel` saves checkpoints.

  **Breaking (types):** removed keys nothing read — `CogitatorConfig.knowledgeGraph` and `promptOptimization` (the knowledge-graph and prompt-optimization classes keep their own config types), `ContextManagerConfig.windowOverlap`, `TimeTravelConfig.autoCheckpoint` / `autoCheckpointInterval`, `ReplayOptions.onStep` / `pauseAt`, and `CompileOptions.teacherModel` / `verbose`. The YAML schema drops the same keys.

- 6404340: `llm.defaultModel` and `limits` now do what they say.

  - An agent may leave out `model` (`AgentConfig.model` is optional): it runs on the Cogitator's `llm.defaultModel`, and a run without either fails with a `CONFIGURATION_ERROR` naming the agent. `cogitator.resolveModel(agent)` returns the model a run uses. **Breaking for types:** `Agent.model` is `string | undefined`.
  - `limits.maxConcurrentRuns` caps concurrent `run()` calls; the rest wait in order, and their timeout and abort signal cover the wait.
  - `limits.defaultTimeout` applies to runs whose options and agent set no timeout. The 120 s default moved from the `Agent` constructor to the runtime, so `agent.config.timeout` is `undefined` unless set.
  - `limits.maxTokensPerRun` is checked before every model call and fails the run with the new `RUN_TOKEN_LIMIT_EXCEEDED` code.
  - Swarms: the assessor and the distributed coordinator resolve models through the Cogitator, so agents without a model work there too (`Assessor.analyze()` takes an optional resolver).

- c1cd7a1: Guardrails take partial configs and keep the revisions they produce.

  - `CogitatorConfig.guardrails` and `security.promptInjection` are `Partial<…>`: fields left out take the defaults, as the runtime always merged them. The YAML schema accepts partial blocks too (`thresholds` may name some categories).
  - Guardrails are on when configured, unless `enabled: false`, matching `DEFAULT_GUARDRAIL_CONFIG`. The run checks the merged config: a partial config such as `{ enabled: true }` filtered nothing before.
  - When the output filter blocked an answer and the critique-revise loop produced a safe one, `filterOutput()` returned `allowed: true` with the revision, so the run kept the original harmful text and the violation was never logged. It now returns the block with `suggestedRevision`, the run answers with the revision, and the violation reaches the log and `onViolation`.
  - `filterToolResults` is implemented: tool results pass the input filter before the model reads them (`ConstitutionalAI.filterToolResult()`).

- 22f47c9: `AgentOptimizer.compile(agent, trainset)` uses the trainset. It ignored it, scored the same stored traces before and after, and so always reported zero improvement, which also kept `AutoOptimizer` from ever deploying a change. Pass `cogitator` to `AgentOptimizer`: `compile()` runs the trainset with the original agent (scoring it and collecting demo candidates) and again with the optimized instructions, so `scoreAfter` is measured. Without a runner it says so in `errors` and estimates `scoreAfter` from the instruction optimizer. Traces are re-read every round and handed to the instruction optimizer.
- 5b12191: Structured output now works in runs. `agent.config.responseFormat` was never passed to the LLM backend by `cogitator.run()`, so `json` and `json_schema` agents were only as structured as their prompt, and `RunResult.structured` was never set. The format now reaches every backend on both the streaming and non-streaming paths (Zod schemas become JSON Schema, strict only when the schema allows it), and `result.structured` holds the parsed answer, validated by the schema. Agents with tools keep calling them: older Claude models and Gemini 2.x, which cannot combine a JSON format with tools, get the schema as an instruction instead. `Agent.serialize()` keeps `responseFormat`.
- f36a121: Time travel works end to end.

  - `compare()` and `compareWithOriginal()` failed with `Trace not found` because nothing wrote to the trace store. Checkpoints, replays and forks now store their traces; a deterministic replay's trace is the original's up to the replayed step.
  - `mockToolResults` (forks) and `modifiedToolResults` (replays) are keyed by tool name, as documented: the tool answers with the given value and never runs. Before, live replays looked them up by call id and never matched. In deterministic replays a modified result now wins over the cached one.
  - `skipTools` removes the tools from the replayed agent; it did nothing before.
  - Checkpoints record the results of tool calls (`toolResults` was always empty) and pick the pending call by call id.
  - `AgentOptimizer.captureTrace()` stores traces under the run's trace id, so it can share a trace store with `TimeTravel`.

### Patch Changes

- 480f2a3: Context management turns on when `context` is configured. The runtime created the context manager only with `enabled: true`, although `enabled` defaults to true and the documented strategy examples leave it out, so those configs silently never compressed anything. Pass `enabled: false` to keep a config switched off.
- 51d581e: OTLP exporter: send valid OpenTelemetry ids. Span ids went out as `span_…` and trace ids as `trace_…` whenever `onRunStart` had not mapped the run, so collectors refused the batch with 400, and the exporter re-queued it forever. Ids are now derived from the Cogitator ids with SHA-256 (32 hex chars per trace, 16 per span), which keeps parent links and works after a run ends; the original ids and the run id are kept as attributes. Attributes keep their types (doubles, booleans, objects as JSON), timestamps are exact, and a batch refused with a 4xx status is dropped instead of retried.
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/memory@0.8.1
  - @cogitator-ai/sandbox@0.4.1

## 0.21.1

### Patch Changes

- 4940750: Google backend: send tool results that are JSON arrays or plain values as `{ result: … }`. Gemini expects `functionResponse.response` to be an object and rejected an array with `400 Proto field is not repeating`, so any tool that returned a list broke the run.

## 0.21.0

### Minor Changes

- The official OpenAI backend uses the Responses API and defaults to `gpt-6.1-sol`; OpenAI-compatible providers stay on Chat Completions (`api: 'responses' | 'chat-completions'` forces either). Encrypted reasoning items are round-tripped between tool calls; reasoning models get no temperature/top_p.
- Anthropic and Bedrock: current Claude models no longer fail with HTTP 400 on the default temperature (sampling params are omitted on Claude 4.7+/Fable, at most one of temperature/top_p on other 4.x); native structured outputs on Claude 4.5+; forced tool choice falls back to auto on models that reject it; default Anthropic model `claude-sonnet-5-5`; more precise stop reasons.
- Retired model ids replaced with current ones (GPT-6, Claude 5.5, Gemini 3.8 / 3.5 Flash-Lite); context windows for GPT-5/6, Claude 5 and Gemini 3.
- **Breaking:** `image-generate` uses `gpt-image-2.5-flare` (DALL-E 3 is retired): results carry `imageBase64`, `url` is optional, default size/quality are `auto` (`config.model` keeps the DALL-E request shape). Transcription defaults to `gpt-transcribe` (`whisper-1` when word timestamps are requested); TTS defaults to `gpt-4o-mini-tts`.
- Errors rethrown from catch blocks keep the original error as `cause`.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/models@18.0.0
  - @cogitator-ai/sandbox@0.4.0
  - @cogitator-ai/types@0.24.0

## 0.20.0

### Minor Changes

- Re-audit of @cogitator-ai/core (+ @cogitator-ai/types). The most important fixes: (1) the first sandboxed tool call of a Cogitator instance ran natively on the host because the executor captured a stale undefined sandbox manager, a security bug; (2) Tool.timeout is now enforced for native tools; (3) trace spans were orphaned because the root span id did not match the children's parentId; (4) tool-call structure is kept intact across runtime, memory, compression and providers: duplicate-call errors are persisted, reflection hints are deferred, and loaded or compressed history is cleaned of orphaned tool results and unanswered calls; (5) RunOptions.audio was documented but silently ignored and is now implemented via Whisper; (6) reflection, guardrails, the LLM injection classifier and cost routing sent provider-prefixed or wrong model ids; (7) backends: Gemini 3 thought signatures are now round-tripped, a new ToolCall.thoughtSignature field was added in types, and the 400 it caused was confirmed with a real API call; system prompts are no longer overwritten for Anthropic, Gemini and Bedrock; parallel tool results are grouped into one turn; OpenAI uses max_completion_tokens; empty tool arguments are handled; Ollama error lines and blocked Gemini prompts are reported; stream errors are wrapped; (8) tools: Postgres read-only queries run in a READ ONLY transaction; SQLite mutations work; Google and Tavily keys are moved out of the URL and body; the deprecated embedding default is fixed; the Redis tool-cache size counter no longer drifts; the HTTP tool handles HEAD requests; self-tools updates are atomic. Docs: invalid @cogitator-ai/core/\* subpath imports were fixed across the advanced docs. Report: docs/audits/core-audit.md (previous report kept as core-audit-2026-05-15.md).

  **Breaking changes**
  - OpenAIBackend against the official endpoint (no baseUrl) now sends maxTokens as max_completion_tokens instead of max_tokens (custom baseUrl and compatible providers unchanged).
  - vector_search Google default embedding model changed from shut-down text-embedding-004 (768 dims) to gemini-embedding-001 (matches @cogitator-ai/memory); pgvector column dimension must match.
  - When security.promptInjection.classifier='llm' is configured through Cogitator without llmModel, the classifier now uses the agent's model instead of a bare 'gpt-4o-mini' on the default provider.
  - Internal (not exported from package root): executeTool/initializeSandbox now take/return SandboxManager | undefined; initializeSecurity takes the agent.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/sandbox@0.3.0
  - @cogitator-ai/types@0.23.0

## 0.19.4

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
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/sandbox@0.2.29

## 0.19.3

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/memory@0.6.21
  - @cogitator-ai/sandbox@0.2.28

## 0.19.2

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.
- Updated dependencies
  - @cogitator-ai/models@17.1.8
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/memory@0.6.20
  - @cogitator-ai/sandbox@0.2.27

## 0.19.1

### Patch Changes

- fix(core): comprehensive audit — 30+ critical/high bugs fixed

  Critical fixes:
  - Streaming: tool call continuation chunks no longer silently dropped
  - Security: prompt injection in LLM classifier fixed, path traversal in self-tools patched, SQL injection in vector-search fixed
  - Constitutional AI: fail-open default removed, violations now always blocked
  - Causal reasoning: d-separation algorithm correctness fix
  - Learning: incompleteBeta replaced with Lentz's continued fraction, postgres trace store race condition fixed

  High-severity fixes:
  - LLM backends: OpenAI tool_calls preserved in multi-turn, Google stream buffer flushed, Anthropic stop_reason captured, Bedrock init cache reset, Ollama reader released
  - Runtime: initialization race condition fixed, ESM require.resolve compatibility
  - Redis cache: KEYS command replaced with counter + SCAN

  Also: 21 missing public API exports added (LLM errors, debug wrapper, plugin system, cost estimators), 6 new test files (68 tests), 9 regression tests, nodemailer peer dependency added.

- Updated dependencies
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/memory@0.6.19
  - @cogitator-ai/sandbox@0.2.26

## 0.18.7

### Patch Changes

- Fix Ollama Cloud tool calling compatibility
  - Preserve tool call IDs returned by Ollama Cloud API instead of generating new ones
  - Include tool_calls on assistant messages when converting conversation history
  - Preserve toolCalls on assistant messages in runtime for multi-turn tool calling

## 0.18.6

### Patch Changes

- fix(core): audit — 37 bugs fixed, +71 regression tests, v0.18.6

  Critical fixes:
  - Streaming tool calls: accumulate/merge by ID instead of overwriting
  - SQL injection prevention in vector-search collection name validation
  - Security evaluator fail-closed on parse errors (was fail-open)
  - Tool guard strict mode logic was inverted
  - pruneTraces deleted newest instead of oldest
  - incompleteBeta overflow for large samples
  - Abort listener memory leak in retry utility
  - Multiple unbounded growth issues capped (OTLP spans, cost records, reflections)
  - Tool error messages now include actual error content for LLM
  - ContentPart[] handling in message builder, forker
  - Causal polynomial evaluation and sampleGaussian NaN guard
  - LLM backend silent error swallowing (Anthropic, Google, Bedrock)
  - Agent clone() no longer duplicates explicit ID

  71 new regression tests covering all fixed bugs.
  5 new test files: streaming, message-builder, tool-executor, opentelemetry, retry.

## 0.18.5

### Patch Changes

- fix(types): audit — 13 bugs/type-safety issues fixed, dead code removed
  - Added missing `responseFormat` to `SerializedAgentConfig`
  - Fixed `DurationString` type (removed useless `| string` union)
  - Added `coherence` field to `TraceMetrics`
  - Removed duplicate config fields in `MetaReasoningConfig`
  - Renamed `turnDuration` to `maxTokensPerTurn` in `DebateConfig`
  - Narrowed `NegotiationTerm.value` to `string | number | boolean`
  - Typed `CapturedPrompt.tools` as `ToolSchema[]`
  - Made `GraphStats` Record fields Partial
  - Removed dead duplicate fields from `MetaAssessment` and `ModificationValidationResult`
  - Removed unused `ProposedActionType`

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/memory@0.6.17
  - @cogitator-ai/sandbox@0.2.25

## 0.18.4

### Patch Changes

- @cogitator-ai/memory@0.6.16

## 0.18.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/models@17.1.6

## 0.18.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.14
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/models@17.1.5
  - @cogitator-ai/sandbox@0.2.24

## 0.18.1

### Patch Changes

- fix(core): audit — 37 bugs & security fixes, +78 tests
  - Fix runtime infinite loop on empty toolCalls
  - Fix multimodal content corruption in message builder
  - Fix empty choices crash in OpenAI/Azure backends
  - Fix temperature=0 / maxTokens=0 ignored in Bedrock
  - Fix streaming JSON parse in Ollama
  - Move Google API key from URL to header
  - Fix LOG_LEVEL validation, tool executor using raw args
  - Fix web-search, github, calculator edge cases
  - Fix fallback crash on empty providers
  - Fix SQLite readonly mode, detection
  - Fix constitutional prompts content handling
  - Fix unsafe casts in rollback manager, thought tree
  - Fix metrics fieldPath drilling (nested paths broken)
  - Fix auto-optimizer using stale test reference
  - Fix causal reasoner wrong agentId extraction
  - Fix langfuse integration (generations/spans non-functional)
  - Fix Google image_url data URI mapping
  - Remove dead code (pendingToolResults, audio transcription)
  - Fix patterns.ts duplicate match indexing
  - Security: SQL injection prevention in sql-query + postgres-trace-store
  - Security: ReDoS protection in regex tools
  - Security: prompt injection fail-closed, allowlist exact-match
  - Security: second-order injection escape in LLM classifier
  - Add public getLLMBackend() and reflectionEngine to Cogitator
  - Add getTest(id) to ABTestingFramework
  - Add 78 new unit tests (rollback, ab-testing, langfuse, metrics, security)

## 0.18.0

### Minor Changes

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

### Patch Changes

- Fix ESM directory import conflicts, streaming content handling, and integration test stability
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/memory@0.6.13
  - @cogitator-ai/models@17.1.4
  - @cogitator-ai/sandbox@0.2.23

## 0.17.4

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/memory@0.6.11
  - @cogitator-ai/models@17.1.2
  - @cogitator-ai/sandbox@0.2.21

## 0.17.3

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/memory@0.6.10
  - @cogitator-ai/models@17.1.1
  - @cogitator-ai/sandbox@0.2.20

## 0.17.2

### Patch Changes

- Update model registry to January 2026 models
  - Add Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
  - Add GPT-4.1, GPT-4.1 Mini/Nano, o3, o4-mini
  - Add Gemini 3 Pro/Flash Preview, Gemini 2.5 Pro/Flash/Flash-Lite
  - Mark deprecated models (Claude 3.x, GPT-4 Turbo, Gemini 1.5/2.0)
  - Fix model selector and cost estimator for new models
  - Export all 26 built-in tools from @cogitator-ai/core

- Updated dependencies
  - @cogitator-ai/models@17.1.0

## 0.17.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/memory@0.6.9
  - @cogitator-ai/models@17.0.0
  - @cogitator-ai/sandbox@0.2.19

## 0.17.0

### Minor Changes

- Add long-context optimization with automatic compression strategies

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/memory@0.6.8
  - @cogitator-ai/models@16.0.0
  - @cogitator-ai/sandbox@0.2.18

## 0.16.0

### Minor Changes

- feat: add audio/speech support with Whisper and TTS

  Audio Transcription (Whisper API):
  - `createTranscribeAudioTool` factory for speech-to-text
  - Support for whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe models
  - Word-level timestamps with verbose_json response format
  - URL and base64 audio input support

  Text-to-Speech (TTS API):
  - `createGenerateSpeechTool` factory for TTS generation
  - Support for tts-1, tts-1-hd, gpt-4o-mini-tts models
  - 13 voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
  - Output formats: mp3, opus, aac, flac, wav, pcm
  - Speed control: 0.25x to 4.0x

  Integration:
  - `AudioInput` and `AudioFormat` types
  - `audio` option in `cog.run()` for automatic transcription
  - `fetchAudioAsBuffer` and `audioInputToBuffer` helpers

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/memory@0.6.7
  - @cogitator-ai/models@15.0.0
  - @cogitator-ai/sandbox@0.2.17

## 0.15.0

### Minor Changes

- 6b09d54: feat(core): implement Agent serialization and deserialization

  Add serialize() and Agent.deserialize() methods for agent persistence:
  - AgentSnapshot format with version field for backward compatibility
  - Tool names stored instead of full tool objects (functions are not serializable)
  - Tool resolution via ToolRegistry or direct array on deserialize
  - Config overrides support during restoration
  - Agent.validateSnapshot() for runtime type checking
  - AgentDeserializationError for clear error messages

  This enables:
  - Pause/resume agents across process restarts
  - Sharing agent configurations as JSON
  - Storing agents in databases

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/memory@0.6.6
  - @cogitator-ai/models@14.0.0
  - @cogitator-ai/sandbox@0.2.16

## 0.14.0

### Minor Changes

- feat(cost-routing): implement cost prediction before agent execution

  Add `estimateCost()` method to Cogitator that estimates the cost of running an agent BEFORE execution.

  New components:
  - `TokenEstimator`: Heuristic-based token estimation
  - `CostEstimator`: Combines task analysis, model pricing, and token estimation

  Features:
  - Complexity-based output token estimates (simple/moderate/complex)
  - Iteration and tool call estimation based on task requirements
  - Confidence scores (lower for complex tasks with many tools)
  - Local model detection (Ollama models return $0 cost)
  - Warnings for unpredictable costs, missing pricing data

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/memory@0.6.5
  - @cogitator-ai/models@13.0.0
  - @cogitator-ai/sandbox@0.2.15

## 0.13.0

### Minor Changes

- feat(security): implement prompt injection detection

  Add PromptInjectionDetector to protect agents from adversarial inputs:
  - Local classifier: fast regex + heuristics (<5ms latency)
  - LLM classifier: semantic analysis for complex attacks
  - 30+ built-in patterns for 5 threat types (direct injection, jailbreak, roleplay, context manipulation, encoding)
  - Allowlist support for false positive prevention
  - Custom pattern support with runtime add/remove
  - Integration with Cogitator via security.promptInjection config

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/memory@0.6.4
  - @cogitator-ai/models@12.0.0
  - @cogitator-ai/sandbox@0.2.14

## 0.12.0

### Minor Changes

- feat(core): implement tool caching layer with semantic matching
  - Add withCache() wrapper for caching tool execution results
  - Support exact match (SHA256 hash) and semantic (embedding similarity) caching
  - InMemoryToolCacheStorage with LRU eviction
  - RedisToolCacheStorage with TTL and sorted sets
  - Cache stats, invalidation, warmup, and callbacks

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/memory@0.6.3
  - @cogitator-ai/models@11.0.0
  - @cogitator-ai/sandbox@0.2.13

## 0.11.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.2

## 0.11.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/memory@0.6.1
  - @cogitator-ai/models@10.0.0
  - @cogitator-ai/sandbox@0.2.12

## 0.11.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/memory@0.6.0
  - @cogitator-ai/models@9.0.0
  - @cogitator-ai/sandbox@0.2.11

## 0.11.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/memory@0.5.2
  - @cogitator-ai/models@8.0.1
  - @cogitator-ai/sandbox@0.2.10

## 0.11.1

### Patch Changes

- Updated dependencies [abdafa3]
  - @cogitator-ai/sandbox@0.2.9

## 0.11.0

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

## 0.10.0

### Minor Changes

- 58a7271: Phase 6: DX Improvements
  - Add structured LLM errors with rich context (provider, model, endpoint, statusCode, retryable, retryAfter)
  - Add debug mode wrapper with request/response logging
  - Add type-safe provider configurations with discriminated unions
  - Add plugin system for registering custom LLM backends

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/memory@0.5.1
  - @cogitator-ai/models@8.0.0
  - @cogitator-ai/sandbox@0.2.8

## 0.9.0

### Minor Changes

- Phase 5: Memory adapters and observability integrations

  Memory Adapters:
  - SQLite adapter with WAL mode for zero-config local development
  - MongoDB adapter for flexible document storage
  - Qdrant vector adapter for semantic similarity search

  Observability:
  - Langfuse exporter for LLM-native observability
  - OpenTelemetry OTLP exporter for universal tracing

  All adapters use dynamic imports - install only what you need.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/memory@0.5.0
  - @cogitator-ai/models@7.0.0
  - @cogitator-ai/sandbox@0.2.7

## 0.8.0

### Minor Changes

- faed1e7: feat(core): add 6 new built-in tools

  New tools for web, database, and productivity:
  - `webSearch` - Search the web via Tavily, Brave, or Serper APIs
  - `webScrape` - Extract content from web pages (text/markdown/html output, CSS selectors)
  - `sqlQuery` - Execute SQL queries against PostgreSQL or SQLite
  - `vectorSearch` - Semantic search with embeddings (OpenAI/Ollama/Google + pgvector)
  - `sendEmail` - Send emails via Resend API or SMTP
  - `githubApi` - GitHub API integration (issues, PRs, files, commits, search)

  All tools support auto-detection of providers from environment variables and use dynamic imports for optional dependencies.

  Also adds new tool categories (`web`, `database`, `communication`, `development`) and `external` side effect type.

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/memory@0.4.3
  - @cogitator-ai/models@6.0.1
  - @cogitator-ai/sandbox@0.2.6

## 0.7.0

### Minor Changes

- 70679b8: feat(core): add Azure OpenAI and AWS Bedrock backends

  Enterprise LLM providers for production deployments:

  **Azure OpenAI:**
  - Full chat and streaming support via official OpenAI SDK
  - Configurable deployment, endpoint, and API version
  - Tool calling, structured outputs, vision

  **AWS Bedrock:**
  - Uses Converse API for unified chat interface
  - Dynamic SDK import (optional peer dependency)
  - Supports Claude, Llama, Mistral, Cohere, Titan models
  - Tool calling with proper type safety

  Both backends integrate seamlessly with the universal LLM interface.

- 2f599f0: feat: add parallel tool execution and tool choice support

  **Parallel Tool Execution:**
  - New `parallelToolCalls` option in `RunOptions` enables concurrent tool execution
  - When enabled, independent tool calls execute via `Promise.all` for improved performance
  - Default remains sequential execution for deterministic behavior

  **Tool Choice:**
  - New `ToolChoice` type: `'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }`
  - New `toolChoice` field in `ChatRequest` interface
  - Provider-specific implementations:
    - OpenAI: native tool_choice support
    - Anthropic: maps to `tool_choice` with `type: 'auto' | 'any' | 'tool'`
    - Google: uses `functionCallingConfig` with mode and allowedFunctionNames
    - Ollama: filters tools based on choice (workaround for no native API support)

- 10956ae: feat: add structured outputs / JSON mode support

  Implement responseFormat parameter across all LLM backends for guaranteed JSON output:
  - **json_object**: Simple JSON mode - model returns valid JSON
  - **json_schema**: Strict schema validation with name, description, and schema definition

  Works with all backends:
  - OpenAI: Native response_format support
  - Anthropic: Tool-based JSON schema forcing
  - Google: responseMimeType and responseSchema in generationConfig
  - Ollama: format parameter with 'json' or schema object

  ```typescript
  // Simple JSON mode
  const result = await backend.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'List 3 colors as JSON array' }],
    responseFormat: { type: 'json_object' },
  });

  // Strict schema validation
  const result = await backend.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Extract person info' }],
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'person',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      },
    },
  });
  ```

- 218d91f: feat: add vision / multi-modal support

  Message content now supports images in addition to text:
  - `MessageContent` = `string | ContentPart[]`
  - `ContentPart` can be `text`, `image_url`, or `image_base64`

  All LLM backends updated to handle multi-modal content:
  - **OpenAI**: `image_url` parts with detail level support
  - **Anthropic**: `image` source with URL or base64
  - **Google Gemini**: `inlineData` and `fileData` parts
  - **Ollama**: `images` array with base64 data

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/memory@0.4.2
  - @cogitator-ai/models@6.0.0
  - @cogitator-ai/sandbox@0.2.5

## 0.6.1

### Patch Changes

- 29ce518: fix(core): preserve full model name when explicit provider is set

## 0.6.0

### Minor Changes

- a7c2b43: feat(core): add explicit provider override in AgentConfig

  Allows specifying provider directly in AgentConfig (e.g., 'openai' for OpenRouter) instead of relying only on model string parsing.

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/memory@0.4.1
  - @cogitator-ai/models@5.0.0
  - @cogitator-ai/sandbox@0.2.4

## 0.5.0

### Minor Changes

- f874e69: ### Memory improvements
  - Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
  - Add Google embedding service using `text-embedding-004` model (768 dimensions)
  - Implement hybrid context strategy (30% semantic + 70% recent messages)
  - Fix foreign key constraint violation when saving entries before thread creation

  ### Swarms improvements
  - Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
  - Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
  - Fix coordinator to properly register pipeline stages and handle missing negotiation section

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/memory@0.4.0
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/models@4.0.0
  - @cogitator-ai/sandbox@0.2.3

## 0.4.0

### Minor Changes

- feat(causal): add causal reasoning engine

  Implement full causal reasoning framework based on Pearl's Ladder of Causation:

  **Causal Graphs**
  - CausalGraphImpl with Map-based storage
  - CausalGraphBuilder fluent API
  - Node/edge operations (parents, children, ancestors, descendants)
  - Path finding with strength accumulation
  - Cycle detection and Markov blanket computation

  **Inference Engine**
  - D-separation algorithm (Bayes-Ball)
  - Backdoor and frontdoor adjustment criteria
  - Interventional effect computation
  - Average Treatment Effect (ATE) estimation
  - Effect identifiability checking

  **Counterfactual Reasoning**
  - Three-phase algorithm: Abduction → Action → Prediction
  - Structural equation evaluation (linear/logistic)
  - Counterfactual query handling

  **Causal Discovery**
  - LLM-based causal extraction from tool results
  - Hypothesis generation from traces
  - Counterfactual validation via forking
  - Pattern recognition and evidence accumulation

  **Types**
  - CausalNode, CausalEdge, CausalGraph interfaces
  - CausalRelationType: causes, enables, prevents, mediates, confounds, moderates
  - InterventionQuery and CounterfactualQuery types
  - StructuralEquation with linear/logistic/custom support

  **Fixes**
  - self-modifying: Fix test API compatibility issues

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/memory@0.3.1
  - @cogitator-ai/models@3.0.0
  - @cogitator-ai/sandbox@0.2.2

## 0.3.0

### Minor Changes

- feat: add Knowledge Graph Memory and Prompt Auto-Optimization

  **Knowledge Graph Memory:**
  - PostgresGraphAdapter for entity-relationship storage with pgvector
  - Multi-hop graph traversal with BFS/DFS algorithms
  - Shortest path finding between nodes
  - Semantic node search with embeddings
  - LLMEntityExtractor for extracting entities/relations from text
  - GraphInferenceEngine for rule-based relationship inference
  - GraphContextBuilder for graph-aware context building

  **Prompt Auto-Optimization:**
  - PostgresTraceStore for persistent trace and prompt storage
  - PromptLogger wrapper for capturing all LLM prompts
  - ABTestingFramework with Welch's t-test statistical analysis
  - PromptMonitor for real-time performance monitoring with degradation detection
  - RollbackManager for instruction version control
  - AutoOptimizer for automated optimization pipeline with A/B testing

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/memory@0.3.0
  - @cogitator-ai/models@2.0.0
  - @cogitator-ai/sandbox@0.2.1

## 0.2.0

### Minor Changes

- **Timeout enforcement**: Agent timeout config now properly enforced using AbortController
- **Tool input validation**: Tool arguments validated with Zod before execution
- **Memory error callback**: Added `onMemoryError` callback to `RunOptions` for handling memory failures
- **Tool categories**: Tools now support `category` and `tags` fields for organization

### Improvements

- Abort signal now passed to tool context for graceful cancellation
- Better error messages for invalid tool arguments

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/memory@0.1.1
  - @cogitator-ai/models@1.0.0
  - @cogitator-ai/sandbox@0.1.1
