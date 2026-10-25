# @cogitator-ai/server-shared

## 0.13.1

### Patch Changes

- Updated dependencies [[`773cb9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/773cb9e8f9d943f60bc3387ac3fbc0c9ebb4c130)]:
  - @cogitator-ai/types@0.78.0

## 0.13.0

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

## 0.12.0

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

## 0.11.0

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

## 0.10.0

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

## 0.9.10

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0

## 0.9.9

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0

## 0.9.8

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/types@0.71.0

## 0.9.7

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0

## 0.9.6

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0

## 0.9.5

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0

## 0.9.4

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0

## 0.9.3

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0

## 0.9.2

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/types@0.64.0

## 0.9.0

### Minor Changes

- [#259](https://github.com/cogitator-ai/Cogitator-AI/pull/259) [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357) - Workflow checkpoints and resume over HTTP in every REST adapter

  With the new `workflowCheckpoints` option (a `CheckpointStore`), a workflow run accepts `options.checkpoint: true` and saves checkpoints there. A finished run answers with its `checkpointId`, and a failed one carries it in the error answer, next to `code` and `message`, and in a `workflow_failed` event before the stream's `error` event. `POST /workflows/:name/resume` and `/workflows/:name/resume/stream` take `{ checkpointId, options? }` and run the remaining nodes, with the server's limits, the caller's auth and the same answers as `/run` and `/stream`. A resumed run saves checkpoints too, so it can be resumed again.

  A checkpoint belongs to the user who ran the workflow: `WorkflowCheckpoint` gets an `owner`, set through `ownedCheckpoints(store, owner)` from server-shared. Another user's checkpoint, one of another workflow, an unknown id and a server without a store all answer `404 CHECKPOINT_NOT_FOUND`, a new error code, before anything runs. Without `workflowCheckpoints`, `options.checkpoint: true` is still refused. OpenAPI documents the resume routes, `WorkflowResumeRequest` and `checkpointId`, and the conformance cases cover the refusals.

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/types@0.63.0

## 0.8.1

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0

## 0.8.0

### Minor Changes

- [#253](https://github.com/cogitator-ai/Cogitator-AI/pull/253) [`8b0fd20`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b0fd2045686cba1675b97163ee7fbea88a723f3) - Stream protocol events as Zod schemas and OpenAPI components, and `/agents/:name/resume/stream` in every REST adapter

  `@cogitator-ai/server-shared` exports a Zod schema for every stream event (`StreamEventSchema`, a discriminated union on `type`, and `StartEventSchema` through `SwarmEventSchema`, `RunUsageSchema`, `PendingApprovalSchema`), so a client can check what a server sends. The schemas have the shapes of the `StreamEvent` types, an unknown event type fails to parse and a field a newer server adds is dropped. `streamEventComponents()` turns them into OpenAPI 3.0 components, and `generateOpenAPISpec` now documents every SSE route as `text/event-stream` with the `StreamEvent` schema, a `oneOf` with a discriminator on `type`. The `RunUsage`, `PendingApproval`, `StreamStartEvent` and `StreamFinishEvent` components keep their names. `documentStreamEvents(document)` adds the same to a document another generator built: Fastify's Swagger document uses it, and a Tetsu document built with `openapi()` can go through it too. `truncated` and `iterationLimitReached` of `AgentRunResponse` and `StreamFinishEvent` are now documented as `true` when present, which is all a server ever sends. `ToolResultEvent.result`, `WorkflowEvent.data` and `SwarmEvent.data` are optional, as on the wire, where a tool that returned nothing sends no `result`.

  Express, Fastify, Hono and Koa serve `POST /agents/:name/resume/stream`, which Tetsu already had: it takes the body of `/resume`, refuses the same requests before the stream opens, and streams the rest of the run like `/stream`. A thread with no paused run ends the stream with an `error` event, `RUN_NOT_PAUSED`.

  The conformance cases now cover `/resume/stream`, and check every event of a stream against `StreamEventSchema`, so an adapter of your own that runs them needs the route.

## 0.7.0

### Minor Changes

- [#251](https://github.com/cogitator-ai/Cogitator-AI/pull/251) [`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc) - Every server adapter keeps one contract: operator run limits, thread authorization, an anonymous policy, one error taxonomy with Retry-After, thread pages and request deps

  `limits: { swarmTimeout, workflowMaxIterations, workflowMaxConcurrency }` on Express, Fastify, Hono, Koa and Tetsu caps what a request may ask a run for. A request gets the smaller of what it asked and the cap, one that asks for nothing gets the cap, over HTTP, streams and WebSocket alike, and the OpenAPI document shows each cap as the default of the field it caps. Next serves no swarms or workflows, so it has no limits.

  `authorizeThread(auth, threadId)` is asked about every thread a request names (agent runs, streams and resumes, swarm runs, the thread routes, WebSocket runs, and the run events a WebSocket subscription receives) on top of the ownership check, and a refusal answers `403 THREAD_FORBIDDEN` before any run starts. On Next it is `authorizeThread(req, threadId)`, asked about the thread the run goes to. `anonymous: 'deny'` answers `401 UNAUTHORIZED` to a caller without a user id, also on paths the server does not know (Tetsu leaves unknown paths and methods to its app, which answers them before any hook), while health, readiness and the docs stay open. Under `'allow'` an unknown path answers `404 NOT_FOUND` in the envelope, and on Koa a wrong method on a known path now answers that `404` too instead of `405`, while `OPTIONS` on a path the router serves answers `204` with the methods it serves in `Allow`, so the router needs no `allowedMethods()`. The default `'allow'` keeps today's behaviour, and on Next the caller is the `userId` that `beforeRun` returns. On Koa the WebSocket server takes the router's `anonymous` unless its own options set one. Tetsu keeps answering `401` when `authenticate` returns `undefined`, as before.

  Errors follow one taxonomy from `@cogitator-ai/server-shared` (`describeHttpError`): a `CogitatorError` answers with its own status or the one of its code, a swarm that ran out of time with `504 RUN_TIMEOUT`, and any other error with `500 INTERNAL_ERROR` without its text, in JSON, stream events and WebSocket frames alike. Answers carry `Retry-After` in whole seconds, at most a day, when the provider said when to retry. Express, Fastify, Hono, Koa and Next answer in the `{ error: { message, code } }` envelope, and Tetsu in its framework's `{ status, message, error }` with the same statuses and codes. Express and Fastify now honour `CogitatorError.statusCode`, and a failed workflow answers with the status of the error that failed it.

  Breaking for `@cogitator-ai/next`: error answers move from the flat `{ error, code }` to the `{ error: { message, code } }` envelope of the other adapters. `useCogitatorChat` and `useCogitatorAgent` read both shapes, so update a client of your own that reads `error` as a string. A `beforeRun` error reaches the client with its message and `code` only when it sets a client error `status` (`400` to `499`) or is a `CogitatorError`, and any other hook error answers `401 Unauthorized` without its text.

  Breaking for `@cogitator-ai/tetsu` streams: an unexpected error in an SSE stream or WebSocket frame now carries `INTERNAL_ERROR`, as on every other adapter, instead of `INTERNAL_SERVER_ERROR`.

  `GET /threads/:id` takes `limit` (1 to 1000) and `cursor`: it answers the newest `limit` messages of what is left and a `nextCursor` for the page before them, until a page reaches the start of the thread. Entries that share one time are counted, so none is skipped or repeated across pages. Without `limit` it answers the whole thread as before, and `updatedAt` is the time of its newest entry when that is later than the thread record. A bad `limit` or `cursor` answers `400 INVALID_INPUT`, or `422 VALIDATION_FAILED` on Tetsu. Next serves no thread routes.

  `deps: (request) => deps` gives agent runs, streams and resumes their `deps` (`context.deps` of their tools) for the request, never read from the body. Over WebSocket, Fastify and Hono build them for every run from the upgrade request, Express and Koa from their own `websocket.deps(req)` hook that takes the raw upgrade request, and Tetsu once per connection at the handshake. On Next a `deps` that `beforeRun` returns wins over the hook.

  `@cogitator-ai/server-shared` exports `RunLimits`, `checkRunLimits`, `swarmTimeoutWithin`, `workflowOptionsWithin`, `AuthorizeThread`, `AnonymousPolicy`, `admitCaller`, `authorizeThreadAccess`, `threadForbidden`, `UNAUTHORIZED`, `describeHttpError`, `cogitatorErrorStatus`, `INTERNAL_ERROR`, `errorEnvelope`, `errorHeaders`, `retryAfterSeconds`, the types `ErrorEnvelope` and `HttpErrorDescription`, `parseThreadPageQuery`, `readThreadPage`, `MAX_THREAD_PAGE_LIMIT`, the types `ThreadPage` and `ThreadPageQuery`, and `SwaggerConfig.limits`. Its conformance cases now cover Retry-After, hidden internal errors, anonymous callers, `THREAD_FORBIDDEN` on runs, streams, resumes and the thread routes, thread pages and deps. `ConformanceRuntime` takes the case so it can fail runs and hold thread entries, and `ConformanceResponse` carries headers. The adapters export their guards (`createAnonymousGuard` on Express, `createAnonymousMiddleware` on Hono and Koa) and Fastify its request schema factories (`workflowRunRequestSchema`, `swarmRunRequestSchema`, `ThreadPageQuerySchema`, `ThreadResponseSchema`), and Tetsu `ThreadQuery` and `DepsBuilder`.

  `@cogitator-ai/memory`: the Redis adapter reads `getEntries` with `before` and `limit` backwards a page at a time from `before`, so reading a long thread one page after another no longer reads everything before each page. Entries of one time written before entries had a `seq` now keep one order (by id) in the Redis and Postgres adapters, whichever way they are read, the order their tree migration already chains them in. MongoDB and SQLite keep the order they were added in. `@cogitator-ai/test-utils` adds the `entry-limit-before` case to the memory adapter conformance cases.

## 0.6.6

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0

## 0.6.5

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0

## 0.6.4

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0

## 0.6.3

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0

## 0.6.0

### Minor Changes

- [#227](https://github.com/cogitator-ai/Cogitator-AI/pull/227) [`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Readiness checks and memory adapter health check contract ([#103](https://github.com/cogitator-ai/Cogitator-AI/issues/103)).

  - Add optional `healthCheck(): Promise<MemoryResult<void>>` to `MemoryAdapter` in `@cogitator-ai/types` and implement it for all five built-in memory adapters (in-memory, redis, postgres, sqlite, mongodb) using lightweight, non-mutating checks.
  - Add shared readiness check logic in `@cogitator-ai/server-shared` with a 3-second timeout per check. Adapters without `healthCheck()` report `unchecked` and fail open, and unconfigured memory does not fail readiness.
  - Update Express, Fastify, Hono, and Koa server adapters to check readiness against memory, returning HTTP 200 when ready and HTTP 503 on failure without exposing internal driver or network details.
  - Add `health-check` scenario to memory adapter conformance suite in `@cogitator-ai/test-utils`.
  - Update OpenAPI specification for `/ready` endpoint with `ReadinessResponse` schema.

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0

## 0.5.19

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0

## 0.5.18

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0

## 0.5.17

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0

## 0.5.16

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0

## 0.5.15

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0

## 0.5.14

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0

## 0.5.13

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/types@0.48.0

## 0.5.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/types@0.47.0

## 0.5.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/types@0.46.0

## 0.5.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/types@0.45.0

## 0.5.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0

## 0.5.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/types@0.43.0

## 0.5.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0

## 0.5.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/types@0.41.1

## 0.5.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0

## 0.5.4

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/types@0.40.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/types@0.39.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/types@0.38.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/types@0.37.0

## 0.5.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The package becomes the one source of the server protocol. `toAgentRunResponse()` builds the answer of an agent run for every adapter: output, thread, usage, tool calls (`{ id, name, arguments }`), `status` and `traceId`, plus `reasoning`, `pendingApprovals`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` when they apply, never the system prompt, the history, trace spans or a paused run's checkpoint. `AgentStreamSession` builds the events of a streamed run: `start` and `finish` name the run's thread (a new one when the request sent none), parts close before a tool call, an answer given in one piece is sent as text, and `finish` carries the run's outcome. `parseRunRequest()` takes an `acceptContext` policy that refuses `context` keys clients may not set (none by default), `parseAddMessageRequest()` refuses roles the server does not accept (`system` by default), and `parseResumeRequest()` and `parseWorkflowRunRequest()` (which refuses `checkpoint: true`) join them. `refuseNonJsonBody()`, `parseJsonBody()` and `readJsonRequestBody()` refuse bodies that are not JSON with `415`, `withSwarm()` closes a swarm once its run ends, `swarmAgentNames()` lists every agent of a swarm, router and pipeline stages included, and `CONFORMANCE_CASES` with `ConformanceRuntime` and `checkConformance()` let an adapter's tests check it answers like every other.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/types@0.36.0

## 0.4.1

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.

## 0.4.0

### Minor Changes

- [`9d40b76`](https://github.com/cogitator-ai/Cogitator-AI/commit/9d40b763f9fb25f9cb7cb2aba8a52ff2989fc5e9) - The `finish` event of a stream now carries the same usage as the JSON run response. The protocol's `Usage` type gains the optional `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` (`RunUsage` is now the same type), and `createFinishEvent` passes its usage through `toRunUsage`, so a run's `RunResult.usage` can be given as is: the event keeps the counts the model reported and leaves out the run's cost and duration, exactly like the JSON answer. Before, a client streaming a run lost the reasoning and cache token counts that `/run` returned. The OpenAPI document gains a shared `RunUsage` schema, used by `AgentRunResponse` and by the new `StreamFinishEvent`.

- [`1c16684`](https://github.com/cogitator-ai/Cogitator-AI/commit/1c16684976705ab5c34778728f27f7efd247242f) - One run contract for every server adapter. `parseRunRequest` and `parseSwarmRunRequest` validate the body of agent and swarm runs (an `input` of only whitespace is refused, so a request that says nothing never reaches the model), `RUN_INPUT_SCHEMA` and `NON_BLANK_PATTERN` give schema-driven adapters the same rule, and `isNonBlankString` checks a single value. `toRunUsage` and the `RunUsage` type describe the usage of a run answer, now with the optional `reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens`. `DEFAULT_SSE_HEARTBEAT_MS`, `encodeHeartbeat`, `resolveSseHeartbeatMs` and `startHeartbeat` let SSE streams write a comment every 5 seconds while a run is silent. The OpenAPI document now states that `input` must contain more than whitespace and lists the three optional usage counts.

## 0.3.1

### Patch Changes

- 65d0cc0: Swagger UI calls the right URLs and offers a bearer token when the server checks credentials. The spec's `servers` now defaults to where the routes are mounted (Express `basePath`, the Hono/Koa mount prefix), and with `auth` configured the spec declares `bearerAuth` as an optional requirement (`swagger.auth` overrides it). The Swagger page escapes the title and the embedded spec, so agent names and descriptions can't inject markup.

## 0.3.0

### Minor Changes

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

## 0.2.1

### Patch Changes

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

## 0.2.0

### Minor Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).
