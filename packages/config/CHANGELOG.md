# @cogitator-ai/config

## 0.29.0

### Minor Changes

- [#297](https://github.com/cogitator-ai/Cogitator-AI/pull/297) [`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c) - Run the hooks of Claude Code's `settings.json` at points of every run, and read a workspace's `AGENTS.md` and `CLAUDE.md` into the agent's system prompt.

  Both are off by default: without `hooks` and `instructions.projectFiles` a run does what it did before. The breaking changes concern middleware written against `afterRun`.

  Breaking:

  - `afterRun` is now called for every run that ends: completed, paused and failed (an abort among them), not only for completed runs. `RunEndEvent` is `FinishedRunEnd | FailedRunEnd`: `event.status` is `completed` or `paused` with `event.result`, or `failed` with `event.error` and no result. Migration: a hook that keeps memory in shape or reads the result starts with `if (event.status !== 'completed') return` and reads `event.result` after it. The built-in extraction, compaction and memory upkeep do exactly that. An error an `afterRun` hook throws was already logged rather than failing the run, and still is.
  - `beforeRun` may return `{ context }` (it returned nothing before), so code that calls a middleware's `beforeRun` itself and types its result as `void` adjusts.
  - `PermissionDecider` has a new value, `hook`, for decisions a `PreToolUse` or `PermissionRequest` hook (or a `beforeToolCall` or `decideApproval` middleware) made: a `switch` over `decidedBy` handles it.

  New:

  - `CogitatorConfig.hooks: { hooks?, settings?, promptModel?, mcp?, allowedHttpHookUrls?, httpHookAllowedEnvVars?, maxOutputBytes?, onHookRun? }`. `hooks` takes the `hooks` of a settings file in code, `settings: true` (or `{ root, userDirs, managedDirs, layers, trusted }`) reads them from the files the permission rules come from: managed, user, project and local, `.claude/` and `.cogitator/`. A project's own files run only for a trusted project: `trusted: true` trusts the `root` the options name (the process's working directory without one), `trustedRoots` lists more roots, `permissions.settings.trusted: true` trusts its own root, so a cloned repository does not run its hooks on your machine and a server does not run the hooks of every workspace it serves. Hooks of every layer add up, a handler in several files runs once, `disableAllHooks` and `allowManagedHooksOnly` work as in Claude Code (neither touches the hooks given in code), a managed `allowedHttpHookUrls` or `httpHookAllowedEnvVars` is a ceiling the other layers only narrow, files are read again once they change.
  - Events: `SessionStart` and `SessionEnd` (a run is a session), `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart` and `SubagentStop` (for runs started from another run's tool call), `PreCompact`, `PostCompact`, `PreModelSwitch` (a handoff to an agent on another model), `Stop` and `Notification`. Matchers are Claude Code's (exact names, `|` lists, regular expressions), tool events match the tool's name, its MCP name and the Claude Code names that cover it (`Bash` for `run_command`), and a handler's `if` takes one permission rule.
  - Handlers: `command` (the event's JSON on stdin and never on the command line, exec form with `args` or `/bin/sh -c`, the project root as working directory, `CLAUDE_PROJECT_DIR` and `COGITATOR_PROJECT_DIR` set, the process environment without `OTEL_*`, a process group of its own killed at the `timeout`, on abort and when a background process it left holds its output, stdout and stderr read up to `maxOutputBytes`, `async`, `hooks.env: 'inherit' | { allow }` to pass only some variables), `http` (a POST to its URL only, redirects not followed, `allowedHttpHookUrls`, header variables only from `allowedEnvVars`), `prompt` (a model asked for `{ ok, reason }`, schema checked, its cost in the run's usage) and `mcp_tool` (through `hooks.mcp`, skipped with a warning without it). Exit code 2 blocks with stderr as the reason, other codes let the action go on (valid JSON on stdout still decides, and `HookRunRecord.outcome` is `error`), `onFailure: 'block'` turns a failure into a block, and the JSON output fields (`continue`, `stopReason`, `systemMessage`, `decision`, `reason`, `hookSpecificOutput` with `permissionDecision`, `updatedInput`, `additionalContext`, `updatedToolOutput`, the `PermissionRequest` `decision`) mean what they mean in Claude Code.
  - `PreToolUse` runs for each call right before it starts, after the earlier calls of the step, and before the permission rules: `deny` refuses, `ask` asks, `allow` skips the prompt only the mode or the tool would show (in `dontAsk` and `auto` mode too, without the classifier), while deny and ask rules and the asks that guard a deny rule still apply, `defer` pauses the run and the hook runs again on resume, `updatedInput` is checked against the schema and decided by the rules, and a paused call keeps those arguments in the checkpoint (`turn.changed`, `turn.admitted`): an approval holds for exactly them. A hook that matches a call by Claude Code's tool name (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Agent`, one each) gets `tool_name` and `tool_input` in Claude Code's shape and its `updatedInput` is read back. `PermissionRequest` `updatedInput` applies without a permissions config too. `UserPromptSubmit` does not run in subagents, `stop_hook_active` holds until the next user message. A `PermissionRequest` prompt hook that answers `ok: false` declines. Each `hooksMiddleware()` keeps its own run state, so the runtime's hooks and an agent's run side by side. Host file tools map `file_path` against the working directory, absolute paths stay absolute. Only calls that start count against the tool call budget, and the step's results reach `PostToolBatch` after a resume as they were (`turn.results`). A stop asked in `beforeModel`, `wrapModelCall` or `afterModel` ends the run before the model call or the answer's tool calls. The thread's access is checked before `SessionStart` hooks run, `continue: false` of a `PermissionRequest` or `PreModelSwitch` hook stops the run, an MCP or prompt hook whose caller ignores the signal times out all the same, an approved call that paused for its own question keeps its approval, a stop starts no further call of the step (they answer `Not started: the run was stopped`), the `Stop` hooks' state survives a pause (`RunCheckpoint.stopHooks`), and `PostToolBatch` sees the arguments calls ran with. A file whose text repeats another's still brings its own imports. A stop also reaches calls that waited for their turn, context added in `beforeModel` goes with that call, a prompt hook that refuses the input is still counted in the usage `onRunError` gets and in the session's spending, and a resumed run keeps the instructions' size limit. `PermissionRequest` answers an approval before `onApproval`. Both are logged with `decidedBy: 'hook'`. Every handler run is saved to the thread as a `custom` entry `{ kind: 'hook', ... }` and reported to `onHookRun` (`HookRunRecord`). The docs list the differences from Claude Code.
  - New middleware hooks, which the hooks are built on: `startRun`, `beforeToolCall`, `decideApproval`, `afterToolBatch`, `beforeStop`, `beforeCompaction`, `afterCompaction`, `beforeModelSwitch` and `onNotification`, and `{ context }` from `beforeRun`. `RunMiddlewareContext` gets `parentRunId`, `permissionMode`, `addContext(text)` (a system message for the next model call, saved to the thread), `stop(reason)` (the run completes with `result.stopped: { reason, middleware }`) and `logEvent(event, note)`. The compactions of `context` and `memory.compaction` ask `beforeCompaction` first. With `beforeToolCall` middleware a step's calls are decided as they start, context added before a pause is kept in `RunCheckpoint.context`, and `PostToolBatch` after a resume sees the whole step.
  - `CogitatorConfig.instructions.projectFiles: true | { files?, rules?, nested?, maxImportDepth?, allowImportsFrom?, maxChars? }` reads `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` from the workspace root down to its `cwd` into the system prompt, each file once, with `@path` imports (relative to the file, at most 4 hops, cycles stopped, inside the workspace unless `allowImportsFrom` allows a directory), the rules of `.claude/rules/` (with `paths` frontmatter they join the conversation once a tool reads or edits a matching file, as do the files of deeper directories) and a 32 000 character limit with a notice of what was cut. Binary files are skipped and block tags inside a file are taken apart. `RunResult.instructions` and `RunCheckpoint.instructions` list the files (`LoadedInstructionFile`), and the thread's log gets a `custom` entry `{ kind: 'instructions', files }`.
  - `@cogitator-ai/config` reads `hooks` (without the MCP caller and `onHookRun`) and `instructions` from config files. `@cogitator-ai/server-shared` carries `RunResult.stopped` in run answers, stream `finish` events and the OpenAPI document, the Fastify and Tetsu schemas keep it.
  - `@cogitator-ai/core` exports `hooksMiddleware`, `loadHookSettings`, `readHookSettings`, `compileMatcher`, `readStdout`, `STOP_HOOK_CONTINUATION_CAP`, `ruleMatchesCall`, `claudeToolOf`, `trustsProject`, `ProjectInstructionsLoader`, `instructionPathsIn` and the instruction defaults. `@cogitator-ai/types` adds `HooksConfig`, `HookSettings`, `HookMatcherGroup`, `HookHandlerConfig` and its four handler types, `HookEventName`, `HOOK_EVENTS`, `HookRunRecord`, `HookMcpCaller`, `HookSettingsOptions`, `InstructionsConfig`, `ProjectInstructionsOptions`, `LoadedInstructionFile` and the events of the new middleware hooks.

### Patch Changes

- Updated dependencies [[`6a4a312`](https://github.com/cogitator-ai/Cogitator-AI/commit/6a4a31247f2eb58eea32d32438187b8ae0ad648c)]:
  - @cogitator-ai/types@0.77.0

## 0.28.0

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

## 0.27.1

### Patch Changes

- Updated dependencies [[`812796a`](https://github.com/cogitator-ai/Cogitator-AI/commit/812796a9f00163c8827be14a650dc3f59f89d941)]:
  - @cogitator-ai/types@0.75.0

## 0.27.0

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

## 0.26.0

### Minor Changes

- [#292](https://github.com/cogitator-ai/Cogitator-AI/pull/292) [`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1) - An Ollama container in the Docker deployment of a project with local models, `cogitator deploy logs`, and the Fly app and organization in the deploy config.

  Behavior change: a docker deployment whose models run on a local Ollama used to reach the Ollama of the Docker host through `host.docker.internal`. From this release its next deploy runs an Ollama container next to the app instead and downloads the models into it on the first start, which takes as long as the download. Set `deploy.services.ollama: false` to keep reaching the Ollama of the host.

  - When the project's models run on a local Ollama, the docker target's Compose file runs an `ollama` service on `ollama/ollama:0.40.10`, with the models in the `ollama-data` volume and a health check. The roles are looked at one by one, in the environment the deployment gets (`deploy.env` included): the chat models the runtime uses (`llm.defaultModel`, `context.summaryModel` unless context is off, the models of the memory stages that are set, `reflection.reflectionModel` with reflection on, `guardrails.model` unless guardrails are off, `security.promptInjection.llmModel` with `classifier: llm`) and the embeddings of `memory.embedding` with `provider: ollama` (`nomic-embed-text` unless `memory.embedding.model` names another). Ollama Cloud models (a `:cloud` tag, or an API key without a URL) belong to the chat role and are never pulled. A role whose Ollama URL points beyond this machine keeps it, the variables it follows are forwarded (`GPU_OLLAMA` for `baseUrl: ${GPU_OLLAMA}`), and only the local roles move to the container. With `llm.defaultProvider: ollama` and no model in the config there is nothing to pull, so the app reaches the Ollama of the host with a warning unless `deploy.ollama.models` lists the models. A one-shot `ollama-pull` service pulls their models before the app starts: each model is an argument after `--`, never part of the script, and one the volume has already is skipped, so a restart without network still starts. A model name `ollama pull` would refuse or read as a flag fails preflight. A failed download fails the deploy with the last lines of the job, and the CLI says that the first start downloads the models. Redis and Postgres stay as they were.
  - A local chat role gets `COGITATOR_OLLAMA_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_URL` and `OLLAMA_HOST` set to `http://ollama:11434`, also when one of them was detected as a secret with a localhost value. Local embeddings get the variables their `memory.embedding.baseUrl` follows, such as `${OLLAMA_EMBEDDING_URL:-http://localhost:11434}`, with the whole URL or only the host for a variable that is the host part, checked to give the service URL, else left alone with a warning. A variable another provider's settings reference is never rewritten, and a variable is set only when it moves no role that stays remote, and the analyzer warns when the embeddings cannot reach the container or when `services.ollama: true` runs one no model uses.
  - `deploy.services.ollama` turns the container on or off. Off, the local roles reach the Ollama of the Docker host through `host.docker.internal` as before, each on the port of its own local URL, and a warning lists the models to pull there. The keys of `deploy.services` replace the detected ones one by one, so the opt-out keeps Redis and Postgres detected from the memory adapter. `deploy.ollama` sets the `models` to pull (the detected ones when unset, models agents name in code are not detected), `gpu: true` to reserve the NVIDIA GPUs of the host and the `image`. On Fly the analyzer warns when Ollama models or `services.ollama` have no Ollama to run on.
  - `cogitator deploy logs [service]` shows the logs of the deployment: `docker compose logs` of the deployed stack on the docker target (`-f, --follow`, `-n, --tail`, 100 lines by default, `--timestamps`, one service such as `app` or `ollama-pull`), `flyctl logs --app <app>` on Fly (`--no-tail` unless following). The commands are built as argument lists, a service name or tail that would read as a flag is refused, flags that do not apply to an action (or to Fly) are usage errors, and a logs command stopped by a signal exits with 128 plus its number. `Deployer.logsCommand()` resolves to the command for custom pipelines, and the optional `DeployProvider.logsCommand()` may return it or a promise of it.
  - `loadConfig({ env })` reads the `${VAR}` references of the file, the `COGITATOR_*` variables and the shared Ollama variables from `env` instead of `process.env`, and `loadEnvConfig(env)` and `loadEnvDefaults(env)` take it too. The deploy analyzer loads the config this way in exactly the environment the app container gets (`deploy.env`, the forwarded secrets and the Ollama variables it sets), and forwards the variables the config reads that are set (`${VAR}` references and `COGITATOR_*` overrides such as `COGITATOR_LLM_DEFAULT_MODEL`), so the app asks for the models the deployment pulled. `configOverrides.ollama` merges into `deploy.ollama` field by field.
  - `deploy.app` names the Fly app, the image name stays the fallback, and `deploy.org` creates a new app with `fly apps create --org <org>`. The config schema and Fly preflight refuse an app name Fly would refuse (lowercase letters, digits and dashes, starting and ending with a letter or digit, 63 characters at most) and an organization that is not a slug. `isFlyAppName`, `isFlyOrgSlug` and `isOllamaModelName` are exported from `@cogitator-ai/types`.
  - The README of a project from `create-cogitator-app` whose docker deployment gets an Ollama container says that it runs and fills its own Ollama.

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0

## 0.25.1

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0

## 0.25.0

### Minor Changes

- [#288](https://github.com/cogitator-ai/Cogitator-AI/pull/288) [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b) - Memory defaults chosen on the memory benchmarks, and a shadow mode for extraction.

  - Behavior change: `memory.contextBuilder` without a `strategy` now uses `hybrid` when `memory.embedding` is set, and `recent` otherwise as before. A runtime with embeddings and no strategy keeps the newest turns as history and also recalls the earlier turns and memory items that match the turn, which embeds every message of a thread once, in the background. On seven long-memory datasets `hybrid` averaged 44.9% against 18.0% for `recent`, as much as `relevant` at three quarters of its cost. A `strategy` you set is kept, so set `strategy: 'recent'` to keep the old behavior.
  - `memory.extraction.mode` (types, core, config): `apply` by default, or `shadow`, which writes every new item as `suggested`, so it reaches no context, no recall and no fact until it is reviewed (`MemoryItems.query` with `statuses: ['suggested']`) and activated (`MemoryItems.activate`). It is `MemoryItems({ shadow: true })` (memory), which also leaves the confidence of other opinions alone. Extraction stays off by default and the docs recommend starting with `shadow`. Compaction stays off by default too.
  - Scaffolded projects with a lasting store (`sqlite`, `postgres`, `redis`, `mongodb`) get long-term memory in `cogitator.yml`: the provider's embedding model in `memory.embedding` with the `hybrid` strategy (`recent` with Anthropic, which has no embedding model), and `memory.files` for the agents' notes. On Ollama the embedding model is pulled with the chat model. The `assistant` preset is among them. Only Postgres keeps the vectors: on SQLite, Redis and MongoDB the message index lives in the process, so after a restart (`cogitator dev` restarts on every change) each thread's messages are embedded again the first time it is used, one embedding per message. That cost is cents beside the gain of `hybrid`, so those templates keep it, and the generated AGENTS.md says so.

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/types@0.71.0

## 0.24.8

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0

## 0.24.7

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0

## 0.24.6

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0

## 0.24.5

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0

## 0.24.4

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0

## 0.24.3

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0

## 0.24.2

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0

## 0.24.0

### Minor Changes

- [#256](https://github.com/cogitator-ai/Cogitator-AI/pull/256) [`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f) Thanks [@6alex6kash6](https://github.com/6alex6kash6)! - Add custom HTTP headers to Ollama provider configuration for authentication proxies and gateways. Headers reach both non-streaming and streaming chat requests, while the JSON content type is preserved and `apiKey` takes precedence over custom authorization regardless of header-name casing. Reject invalid HTTP headers when constructing the backend. Normalize all trailing slashes in the Ollama base URL before building request endpoints.

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0

## 0.23.4

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0

## 0.23.3

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0

## 0.23.2

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0

## 0.23.1

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0

## 0.23.0

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

## 0.22.0

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

## 0.21.0

### Minor Changes

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

## 0.20.0

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

## 0.19.0

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

## 0.18.0

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

## 0.17.6

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0

## 0.17.5

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0

## 0.17.4

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0

## 0.17.3

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0

## 0.17.2

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0

## 0.17.1

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0

## 0.17.0

### Minor Changes

- [#210](https://github.com/cogitator-ai/Cogitator-AI/pull/210) [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b) - Agents can fall back to other models. `fallbackModels` on an agent lists models a turn moves to, in order, when its model fails in a way another model may not: the provider is down, overloaded or timing out after its retries, the account is out of quota, the key is rejected, the model is gone, the prompt does not fit its context window or its answer could not be read. Rate limits and server errors are still retried on the same model first (`llm.retry`), quota, authentication, permission and missing-model errors move at once, and `content_filter` and `invalid_request` failures, which another model would refuse as well, never move. An aborted run never moves either.

  Each model has a circuit breaker shared by the runtime's runs, `llm.modelCircuitBreaker` (`failureThreshold` 5, `resetTimeout` 30 000 ms, `halfOpenRequests` 3 by default, also accepted by `cogitator.yml` through `@cogitator-ai/config`): a model that keeps failing, or fails in a way that lasts, is skipped until its breaker lets a call through again. A prompt too long for a model and a call cut short by the run's abort or timeout do not count against it. Every turn starts from the agent's model, a stream moves only before its first token, a fallback turn is priced at the model that answered it, `onModelFallback` and an `llm.fallback` span report every move, and `RunResult.modelUsed` names the model of the final answer. When every model fails the run ends with their shared error code, or `LLM_UNAVAILABLE` when they failed differently, each failure in `details.attempts`. `fallbackModels` survives `agent.serialize()` (and `Agent.validateSnapshot` checks it) and the agent wire format.

  A turn the provider ends with `finishReason: 'error'` moves like an unreadable answer, its tokens still counted. A turn that moves to a model with a smaller context window than the agent's model gets its messages cut to fit that window: the system prompt and the newest messages stay, and no tool result loses its call.

  An agent without `fallbackModels` behaves exactly as before. New exports: `FallbackModel`, `ModelFallbackEvent`, `ModelCircuitBreakerConfig` and `ModelCircuitBreakerConfigSchema`.

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/types@0.45.0

## 0.16.1

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0

## 0.16.0

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

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0

## 0.15.0

### Minor Changes

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - Model prices of your own and an offline catalogue. `llm.pricing` sets prices in USD per million tokens by model, for a fine-tune, a model newer than the catalogue or a negotiated rate: `pricing: { 'openai/gpt-4o': { input: 2, output: 8 } }`. A key matches the model string a run uses or its tail after any `/`: `openai/gpt-4o` prices that model string and the ones ending in it, such as `openrouter/openai/gpt-4o`, and `gpt-4o` the model at every provider that serves it under that name. These prices win over the model registry for run costs, cost-routing budgets, `estimateCost()`, Tree of Thoughts and `decide()`, and `Cogitator.pricer` exposes them.

  A call whose provider reports no cost and whose model has no price used to count as $0 without a word. It still counts as $0, and the runtime now warns once per model, naming the `llm.pricing` key that fixes it. Ollama and vLLM run on your own hardware, so their calls are free unless `llm.pricing` prices them, even when a reseller lists a model of the same name, and stay quiet. A call is priced by the provider it routes to, under the name it is registered by (`llm.backends.vllm` prices as `vllm/...`), and a model string without a provider by the provider it runs on, `cog.pricedModel(model)` says which.

  An Ollama or vLLM backend you register under a name of your own (`llm.backends.gpu2`) is free the same way.

  A catalogue model listed without a price is no longer priced at $0: it keeps its context window and capabilities, carries `priceUnknown: true`, and the price lookups answer `null`, so its calls warn like any model without a price. A listing with a price wins over one without when a name matches several, automatic model selection skips cloud models without a price, and file caches written by earlier versions are fetched again (offline, an older cache gives way to the bundled copy).

  `@cogitator-ai/models` ships a trimmed copy of the LiteLLM catalogue with its MIT notice (`LITELLM_SNAPSHOT`), the priced text and embedding models at a pinned LiteLLM commit named in `source`. The registry prices models from it when it can neither fetch the catalogue nor read its cache, and for lookups made before `initializeModels()`, where it used to know only the built-in models. Refresh it with `pnpm --filter @cogitator-ai/models snapshot`. `ModelPricer` prices by overrides of your own over the registry and `costOf` prices usage at a given `ModelPricing`.

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - OpenAI-compatible servers get only the request fields they understand. A server profile says which field takes the output token limit, whether streams ask for usage with `stream_options` and which `reasoning_effort` values the server takes. Set it with `profile` on `llm.providers.openai` or `llm.providers.vllm`, by preset name (`openai`, `generic`, `vllm`, `ollama`, `lmstudio`, `llamacpp`, `groq`, `together`, `deepseek`, `mistral`, `openrouter`) or field by field over a preset. An effort the server does not take is sent as the nearest one it does.

  The built-in providers use their own preset. Mistral rejects fields it does not know, so it no longer gets `stream_options` (its streams failed with 422) or efforts beyond `high`. DeepSeek gets `none`, `low`, `high` or `max`, Together `low`, `medium` or `high` and no `stream_options`, Groq `max_completion_tokens`. A server without a preset keeps the request it got before. The Responses API path of the official OpenAI provider follows the profile's `reasoningEffort` too.

- [#202](https://github.com/cogitator-ai/Cogitator-AI/pull/202) [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd) - Anthropic and Google take `baseUrl` and `headers`, for a gateway or proxy in front of the provider: `llm.providers.anthropic.baseUrl` (or `ANTHROPIC_BASE_URL`, `COGITATOR_ANTHROPIC_BASE_URL`) and `llm.providers.google.baseUrl` (or `COGITATOR_GOOGLE_BASE_URL`), the Gemini one with its API version, `https://generativelanguage.googleapis.com/v1beta` by default. `headers` also works for `openai`, `openrouter` (for example OpenRouter's `HTTP-Referer` and `X-Title`) and `vllm`, and Bedrock takes an `endpoint` for VPC endpoints and proxies.

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0

## 0.14.2

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/types@0.41.1

## 0.14.1

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0

## 0.14.0

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

## 0.13.0

### Minor Changes

- [#149](https://github.com/cogitator-ai/Cogitator-AI/pull/149) [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e) - A model call that hangs no longer eats the whole run. `llm.retry.requestTimeout` sets how long one call may take: a call with no answer by then is aborted and retried like a dropped connection, as a retryable `LLM_TIMEOUT`, and a stream gets that long for each chunk (a stream that stalls after its first chunk fails, as any broken stream does). Before, a request the provider never answered waited for the SDK's own timeout, ten minutes for OpenAI-compatible servers, so a run with a shorter `timeout` failed without a retry while other calls to the same model answered in seconds. It is off by default, and YAML configs take it as `llm.retry.requestTimeout`.

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0

## 0.12.2

### Patch Changes

- [#144](https://github.com/cogitator-ai/Cogitator-AI/pull/144) [`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198) - Prompt caching for Claude shares the system prompt between runs and reaches Claude through OpenRouter.

  Anthropic requests now mark the end of the agent's instructions at the start of the system prompt, so runs with different input, such as single-turn runs that share only their instructions, read those from the cache instead of writing them again. The top-level mark on the end of the conversation is set only when another turn is likely (the request offers tools or continues earlier turns), since a single turn with unique input only paid the cache write premium on it. `llm.promptCache.conversation` overrides that choice, and `ChatRequest.cachePrefix` names the stable start of a request's system prompt.

  An `OpenAIBackend` for OpenRouter (`provider: 'openrouter'` or an `openrouter.ai` base URL) marks `anthropic/*` models the same way, where before it sent no marks and Claude never cached. Its usage reports OpenRouter's `cache_write_tokens` as `cacheWriteTokens`. Other OpenAI-compatible servers and models are left unmarked.

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.12.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.12.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Bedrock works with temporary AWS credentials again. `loadConfig` no longer copies `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` into `llm.providers.bedrock`, where they replaced the SDK credential chain without the session token and STS, SSO or CI role credentials failed with `UnrecognizedClientException`. The AWS SDK now resolves them itself, together with `AWS_SESSION_TOKEN` and `AWS_PROFILE`. Static credentials come only from `COGITATOR_BEDROCK_*` or `llm.providers.bedrock`, which gains `sessionToken` and `profile` (also `COGITATOR_BEDROCK_SESSION_TOKEN` and `COGITATOR_BEDROCK_PROFILE`), and `BedrockBackend` sends them to the SDK.

  `PROVIDER_ENV` in `@cogitator-ai/config` lists the environment of every built-in provider, and `resolveModelRoute()` in `@cogitator-ai/types` is the one rule for which provider a model string runs on, used by the runtime and by `cogitator deploy`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `cogitator deploy` tells servers from workers. `deploy.kind` is `server` (answers HTTP, gets a health check, may scale to zero on Fly) or `worker` (a channel gateway or queue worker: no health check, a port only when one is set, never stopped by the Fly proxy), detected from the project's dependencies. A project that is neither, such as a script that exits after one call, fails preflight instead of being restarted forever. Tetsu and Next.js join the detected servers, with `/health` as the Tetsu health path, and a server whose health path is unknown gets no failing health check.

  Preflight now starts with project checks every target shares: a missing `package.json` (a `cogitator wizard` assistant runs with `cogitator up`), an unknown project kind, a `start` script that loads `.env` with `--env-file` (the file stays out of the image, use `--env-file-if-exists`), and a project whose `.env` holds variables while no secrets were detected. On Docker, a deploy only succeeds when the app container keeps running for a few seconds after it starts, otherwise it fails with the container's last log lines.

  A SQLite memory keeps its database directory on a Docker named volume or a Fly volume (`deploy.volumes`, created on the first Fly deploy), and the directory stays out of the image. A local Ollama on the docker target is reached on the host through `host.docker.internal` (`deploy.hostGateway`). On Fly, Redis and Postgres are no longer silently dropped: `REDIS_URL` and `DATABASE_URL` become required secrets.

  Secrets follow the runtime: the provider is resolved the way the runtime routes the model (`meta-llama/...` on Together needs `TOGETHER_API_KEY`), Azure needs its endpoint, Bedrock a region, an alias such as `GEMINI_API_KEY` is passed when it is the one set, and values written in `llm.providers` count as provided. Names passed to `requireEnv('NAME')` in `src/` and set variables of `.env.example` are detected too.

  The Dockerfile copies `pnpm-workspace.yaml`, `.npmrc`, `patches/` and the other files the install step reads before it runs, so pnpm's `allowBuilds`, overrides, patches and private registries apply in the image. Yarn Berry installs with `--immutable` (and `workspaces focus` for production on Yarn 4), and Bun projects build on `oven/bun:1-alpine` and start with `bun run start`.

  `DeployOptions` gains `configPath` (the file `cogitator deploy -c` passes, read for the model, memory and deploy section alike) and `env`, `status` and `destroy` take `{ configPath }`, and `PackageManager` gains `yarn-berry` and `bun`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `OLLAMA_HOST`, `OLLAMA_URL` and the new `OLLAMA_BASE_URL` are read the way Ollama reads `OLLAMA_HOST`. `OLLAMA_HOST=0.0.0.0`, set so `ollama serve` listens on every interface, used to send every call to port 80 and fail with `ECONNREFUSED`. Now a value without a scheme gets port 11434 and a wildcard address is reached as `localhost`, in `loadConfig` and in the CLI alike (`resolveOllamaHost()`). These variables also no longer replace an explicit `llm.providers.ollama.baseUrl` from cogitator.yml, they apply only when the file sets none (`loadEnvDefaults()`), while `COGITATOR_OLLAMA_BASE_URL` still overrides it. `loadEnvConfig()` therefore no longer returns them.

  `loadConfig` looks for `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml` and `.cogitator.yaml` in that order, the same order `cogitator run` and `cogitator deploy` use (`findConfigFile()`).

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Trailing slashes of base paths and URLs (A2A server and client, `OLLAMA_HOST`, the vector search Ollama URL, the scaffolder's Ollama URL, deploy volume names and paths) are trimmed with a loop instead of `replace(/\/+$/, '')`. That pattern backtracks in quadratic time, so a value with a long run of slashes followed by any other character took seconds to process.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` checks the vector size of an existing `embeddings` table on `connect()`. An adapter without a configured size adopts it, and one configured for another size (after switching the embedding model) reports the mismatch through `vectorStatus()` and a clear failure from `addEmbedding` and `search` instead of a Postgres error on each search. The size can now be set with `dimensions` in `PostgresAdapterConfig` and `memory.postgres.dimensions`, as well as `setVectorDimensions()`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `PostgresAdapter` connects to Postgres without pgvector. Before, the `CREATE TABLE ... vector(N)` that followed a failed `CREATE EXTENSION` failed `connect()`, so memory was off entirely even for users who only need threads. Threads, entries and facts now work on any Postgres, embedding operations return a failed result naming the reason, and the new `vectorStatus()` tells whether vectors are usable. The runtime does not use such a store for semantic context and logs why.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Reasoning models get the parameters they accept on Chat Completions too. `azure/gpt-5` with `maxTokens` sent `{ temperature: 0.7, max_tokens: 500 }` and Azure rejected every call, and `openai/gpt-5` with stop sequences or `api: 'chat-completions'` sent the agent's default temperature. Reasoning models (o-series, GPT-5 and later) now get no `temperature` / `top_p` and their limit as `max_completion_tokens`. Azure tells them by the deployment name or by the new `providers.azure.model` when the name is your own, and its default `apiVersion` is now `2025-04-01-preview`, the first that serves these models.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0

## 0.11.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 0.11.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 0.11.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 0.11.5

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/types@0.33.1

## 0.11.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 0.11.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 0.11.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.11.0

### Minor Changes

- 8bcf914: The config schema silently dropped runtime options it did not know. YAML and `defineConfig` now keep `sandbox.allowNativeFallback`, `sandbox.pool.reuseContainers`, sandbox `defaults` mounts/env/WASM fields, embedding `dimensions` (and the Google `baseUrl`), every `contextBuilder.graphContextOptions` field, prompt injection `patterns` and `failMode`, `guardrails.constitution`, `llm.plugins` and `prompts.autoDeployWinner`.

### Patch Changes

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

## 0.10.1

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.10.0

### Minor Changes

- 0933009: Personal data stays away from the model provider. `security.pii` replaces emails, phone numbers, card numbers (Luhn-checked), IBANs (mod-97), SSNs, IP addresses, API keys and your own patterns with placeholders such as `[EMAIL_1]` in every LLM request. In `mask` mode the answer, its stream and tool call arguments get the real values back, so tools still act on the real address; `redact` keeps the placeholders everywhere, and `block` rejects such input with `PII_DETECTED`. `onDetect` receives counts per kind for audit logs, never the values. `PiiMasker`, `PiiVault` and `withPiiMasking` are exported for use outside a run, and YAML config accepts custom patterns as strings.
- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.9.0

### Minor Changes

- 9ff5a06: Agent runs retry failed LLM calls instead of failing on the first 429 or 5xx.

  - New `llm.retry` (`maxRetries` 2, `baseDelay` 1000, `maxDelay` 30000, `maxRetryAfter` 60000, `onRetry`; `false` turns it off) applies to every backend the runtime uses, `llm.backends` and plugins included. Only retryable errors are retried: rate limits, 5xx, timeouts, dropped connections.
  - A provider's wait is honoured: `retry-after`, `retry-after-ms`, an HTTP date or Gemini's `RetryInfo.retryDelay`. A wait longer than `maxRetryAfter` fails the call at once.
  - Streams are retried only before their first chunk; the run's timeout and abort signal stop the waits.
  - `withLLMRetry(backend, config)` / `RetryingBackend` give a standalone backend the same behaviour; `retryAfterFromHeaders` is exported.

  **Behaviour changes:** backends created by `createLLMBackend` no longer retry inside the OpenAI, Anthropic, Azure and Bedrock SDKs (new `maxRetries` backend option, the runtime passes 0), so attempts never multiply — wrap such a backend with `withLLMRetry` when using it on its own. `LLMError.retryAfter` now holds only a wait the provider asked for; it is `undefined` instead of an invented 60 s (429), 5 s (5xx) or 1 s otherwise. `cogitator.route()` returns the retrying wrapper unless `llm.retry` is `false`.

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.8.0

### Minor Changes

- f134b01: Config keys that did nothing now either work or are gone.

  - `reflection.reflectAfterError` works: a failed tool call gets the error reflection (`ReflectionEngine.reflectOnError`), and its suggestion reaches the next model call.
  - `TimeTravelConfig.maxCheckpointsPerTrace` and `checkpointRetention` are enforced when `TimeTravel` saves checkpoints.

  **Breaking (types):** removed keys nothing read — `CogitatorConfig.knowledgeGraph` and `promptOptimization` (the knowledge-graph and prompt-optimization classes keep their own config types), `ContextManagerConfig.windowOverlap`, `TimeTravelConfig.autoCheckpoint` / `autoCheckpointInterval`, `ReplayOptions.onStep` / `pauseAt`, and `CompileOptions.teacherModel` / `verbose`. The YAML schema drops the same keys.

- c1cd7a1: Guardrails take partial configs and keep the revisions they produce.

  - `CogitatorConfig.guardrails` and `security.promptInjection` are `Partial<…>`: fields left out take the defaults, as the runtime always merged them. The YAML schema accepts partial blocks too (`thresholds` may name some categories).
  - Guardrails are on when configured, unless `enabled: false`, matching `DEFAULT_GUARDRAIL_CONFIG`. The run checks the merged config: a partial config such as `{ enabled: true }` filtered nothing before.
  - When the output filter blocked an answer and the critique-revise loop produced a safe one, `filterOutput()` returned `allowed: true` with the revision, so the run kept the original harmful text and the violation was never logged. It now returns the block with `suggestedRevision`, the run answers with the revision, and the violation reaches the log and `onViolation`.
  - `filterToolResults` is implemented: tool results pass the input filter before the model reads them (`ConstitutionalAI.filterToolResult()`).

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.7.0

### Minor Changes

- `providers.openai.api` (`responses` | `chat-completions`) is accepted in YAML config.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 0.6.0

### Minor Changes

- The documented `${VAR}` references in cogitator.yml were never interpolated: a literal '${OPENAI_API_KEY}' was sent as the API key. ${VAR}, ${VAR:-default}, ${VAR-default} and $$ are now implemented and exported. OLLAMA_API_KEY in the environment overrode a YAML Ollama baseUrl with https://ollama.com; the schema now applies the Ollama default after merging. OLLAMA_URL is now supported, OLLAMA_HOST without a scheme is normalised, and GEMINI_API_KEY is accepted as a Google alias. YAML whose top level is not a mapping was merged as garbage; it now fails with the file path. Prototype keys are skipped during merge. Validation errors are formatted with z.prettifyError. Port and integer fields are validated. The DeployTarget enum is narrowed to docker|fly. Added a shared parseDotenv/loadDotenvFile, now used by the CLI and deploy; a round-trip test caught an escaped-quote bug in it, now fixed. Removed the bogus typescript peerDependency. Fixed an env-dependent flaky test.

  **Breaking changes**
  - The env layer no longer sets the Ollama baseUrl when only OLLAMA_API_KEY is set. The default is applied after merging, so a YAML baseUrl now wins (previously env forced https://ollama.com).
  - ProvidersConfigSchema.ollama input `baseUrl` is now optional; output still always has baseUrl.
  - DeployTargetSchema is narrowed to 'docker' | 'fly'.
  - deploy.port must be an integer in 1-65535. instances, maxConcurrentRuns and maxTokensPerRun must be integers.
  - YAML strings containing `${...}` or `$$` are now interpolated.
  - loadYamlConfig throws for non-mapping files and includes the path in parse errors.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 0.5.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.5.5

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.5.4

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.
- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.5.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.5.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.5.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.4.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.3.13

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.3.12

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.3.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.3.8

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.3.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.3.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 0.3.4

### Patch Changes

- docs: sync package READMEs with main documentation

## 0.3.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 0.3.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 0.3.0

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

## 0.2.8

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 0.2.5

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 0.2.0

### Minor Changes

- Add YAML loader tests (file not found, parsing, default paths)
- Add config merge tests (priority order, deep merge, validation)
- Fix unsafe type cast for LLM provider validation
- Fix parseInt edge case (stricter number parsing with regex)

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
