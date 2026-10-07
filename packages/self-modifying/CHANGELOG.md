# @cogitator-ai/self-modifying

## 19.4.1

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/types@0.37.0

## 19.4.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `MCPServer` and `SelfModifyingAgent` run tool calls through `cogitator.invokeTool()` instead of calling `execute` directly, so approval, the guardrails, the sandbox and `tool.timeout` apply as in an agent run.

  - `MCPServer` asks for a tool that needs approval through MCP elicitation, and refuses it with a clear `isError` result when the client cannot be asked. Before, `serveMCPTools([...builtinTools])` over HTTP ran `exec` on the host without anyone approving it. The new `toolInvoker` option takes your Cogitator so its sandbox manager and guardrails are used, and `serveAgents` uses its host for that. Arguments are still parsed exactly once.
  - `SelfModifyingAgent` takes `toolInvoker` and `onApproval`. A call nobody approves is refused and the model is told why, a sandboxed tool runs in the sandbox, and a tool whose parameters are a JSON schema (for example from `fromAISDKTool`) runs instead of failing the whole run with `safeParse is not a function`. `close()` releases the Cogitator the agent creates when no `toolInvoker` is given.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0

## 19.3.8

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/types@0.35.0

## 19.3.7

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0

## 19.3.6

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2)]:
  - @cogitator-ai/types@0.33.2

## 19.3.5

### Patch Changes

- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/types@0.33.1

## 19.3.4

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0

## 19.3.3

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/types@0.32.0

## 19.3.2

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/types@0.31.0

## 19.3.1

### Patch Changes

- [`aaa4a1e`](https://github.com/cogitator-ai/Cogitator-AI/commit/aaa4a1e656e70f749fd72f3d64c4210f1ee3ca79) - Reject generated tools whose code does not compile, and repair code a model escaped twice. A compile error in the sandbox was reported as an error thrown by the tool, so the validator accepted a tool that could never run as long as its checks allowed a descriptive error. Code that arrives on one line with literal `\n` sequences is now unescaped once when that makes it compile.

## 19.3.0

### Minor Changes

- [`01a3d51`](https://github.com/cogitator-ai/Cogitator-AI/commit/01a3d514aa1795bdbeb6d10a9ecd0ab44396df97) - Correct generated tools are no longer rejected, and a generated tool is reused instead of generated again.

  - `ToolValidator` follows the reviewer's verdict. Any note in a review's `securityIssues` or `logicIssues` used to make the tool invalid and drop its score to 0, even when the review approved it, so with the default `requireLLMValidation: true` real models failed tools on minor remarks and the agent ran without one. An approving review now keeps the tool valid and its notes become `suggestions`. A review that recommends `revise` or `reject` still makes the tool invalid. Static security checks and failed sandbox tests stay authoritative whatever the review says.
  - Without explicit test cases, the validator no longer requires a tool to succeed on synthesized placeholder input (such as `'test'` for every string), which failed tools that reject malformed input as the generation prompt asks. Synthesized inputs now only prove the tool runs. The generator asks the model for a few valid example inputs, and those must succeed.
  - A generated tool is described by what it does. Its description used to be the gap text ("No available tool to compute ..."), so the next gap analysis decided the capability was still missing and generated a duplicate. The model now writes the description, an empty one or a copy of the gap text falls back to the gap's `requiredCapability`, and the gap analysis prompt says that listed tools, including generated ones, cover their capability.
  - Gap analysis sees the agent's instructions (`GapAnalyzer.analyze(input, tools, { instructions })`, passed by `SelfModifyingAgent`), so a task the instructions require a tool for counts as a gap.
  - New `config.maxInternalTokens` on `SelfModifyingAgent`, and `maxTokens` on `GapAnalyzer`, `ToolGenerator`, `ToolValidator`, `CapabilityAnalyzer` and `ParameterOptimizer`, bound the output tokens of their internal LLM calls, so reasoning models no longer spend minutes on them.

### Patch Changes

- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 19.2.1

### Patch Changes

- 7ff75dd: `ToolSandbox` no longer counts worker start-up against `maxExecutionTime`. The limit used to start before the worker thread was spawned, so on a loaded machine (where a worker can take hundreds of milliseconds to boot) tools with short limits timed out before running a single line. The limit now starts once the worker is online, with a separate 10 s guard for a worker that never starts. A tool that hits the limit is always reported as a timeout, never as an error thrown by the tool, so `allowThrow` test cases no longer pass for tools that hang.

## 19.2.0

### Minor Changes

- aef2008: `metaReasoning.modeProfiles` accepts profiles for only some modes and only some fields (`MetaReasoningOverrides`, `ModeProfileOverrides`); each is merged over the default profile of its mode, so a partial profile no longer drops the mode's other fields. `mergeModeProfiles` is exported.

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

## 19.1.3

### Patch Changes

- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 19.1.2

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 19.1.1

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 19.1.0

### Minor Changes

- 126bd47: No more model `'default'`. Components called their LLM with the literal model name `'default'` when none was given, which every backend except Google rejected with a 404, and a checkpoint without a model switched the running agent to it. **Breaking:** `GapAnalyzer`, `ToolGenerator` and `ParameterOptimizer` require `model`; `ToolValidator` and `CapabilityAnalyzer` require it when they call an LLM; `SelfModifyingAgent` requires the agent to set a model; `llmChat()` takes a required `model`. Rollback keeps the current model when a checkpoint has none.

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 19.0.0

### Major Changes

- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 18.0.0

### Major Changes

- Fixed a critical sandbox escape. Generated tools could reach the worker's `process` through host-realm constructors: Array["constr"+"uctor"]("return process")() gave getBuiltinModule('child_process') and the full process.env (95 vars, including API keys). Verified against the previous code. The sandbox is rewritten: a fresh vm context with no host objects, JSON-only boundary, code generation disabled, empty worker env. Other fixes: generated tools never became 'active' (getGeneratedTools always empty); tools were stored before the constraint check and never loaded in later runs; toJSON nested the whole JSON schema inside properties; llm.complete ignored the model; every config_change was rejected and triggered a rollback because tool-only safety rules were applied to it (added SafetyConstraint.appliesTo in types); the parameter optimizer never learned (recordOutcome never called, nothing ever adopted); LLM candidate configs with hallucinated models were applied unvalidated; meta-reasoning ignored config.triggers, accepted recommendations with no confidence and its parameter adjustments did nothing; the run loop re-ran the agent up to 10 times for any answer under 50 characters; config.enabled was ignored; concurrent runs shared one context; agent temperature/maxTokens and the provider prefix were ignored; tool args were not schema-validated; on() handlers were typed `never`. The validator flagged RegExp.exec as shell execution, and its generated test cases contradicted each other, so correct tools were rejected. READMEs/docs were fixed (broken Quick Start, wrong method names and signatures).

  **Breaking changes**
  - SelfModifyingAgent.on() now returns an unsubscribe function, and handlers are typed per event via SelfModifyingEventDataMap (previously typed `never`).
  - ToolContext.agentId passed to tools is agent.id (matches core), not agent.name.
  - Short answers no longer trigger repeated agent runs. Meta-reasoning only intervenes on incomplete steps (empty or truncated answer).
  - Architecture evolution only changes the model when the new availableModels option is set. The baseline reflectionDepth is 0. toolStrategy 'parallel'/'adaptive' now runs tool calls concurrently.
  - Default safety constraints now carry appliesTo ['tool_generation','tool_creation'], so config changes are no longer checked against them.
  - ToolGenerator.generateQuick returns null when no valid tool is produced (previously returned the failed tool).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 17.0.18

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
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/neuro-symbolic@15.1.16
  - @cogitator-ai/types@0.22.3

## 17.0.17

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/neuro-symbolic@15.1.15

## 17.0.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/neuro-symbolic@15.1.14

## 17.0.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/neuro-symbolic@15.1.13

## 17.0.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7
  - @cogitator-ai/neuro-symbolic@15.1.12

## 17.0.13

### Patch Changes

- fix: pass model name through to all internal LLM calls instead of hardcoded 'default'

  All internal callLLM methods in tool-generator, tool-validator, gap-analyzer,
  parameter-optimizer, and capability-analyzer were hardcoding model: 'default'
  which broke with OllamaBackend. Now correctly pipes agent.model to all components.

## 17.0.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6
  - @cogitator-ai/neuro-symbolic@15.1.11

## 17.0.11

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
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/neuro-symbolic@15.1.10

## 17.0.10

### Patch Changes

- fix(self-modifying): audit — 25+ bugs fixed, +22 tests, docs updated

  Critical: executeAgentStep stub now delegates to LLM, getAvailableTools returns actual tools,
  tool compilation routed through sandbox, constructor escape pattern blocked, periodic trigger added.

  High: requiresAdaptation derived from assessment, detached array bug in MetaReasoner fixed,
  memory leak via cleanupRun, unsandboxed timeout added.

  Medium: balanced-brace JSON extraction replaces greedy regex, AND/OR precedence fixed,
  deep config merging, custom constraint deduplication, event emitter error isolation.

## 17.0.9

### Patch Changes

- @cogitator-ai/core@0.18.4
- @cogitator-ai/neuro-symbolic@15.1.9

## 17.0.8

### Patch Changes

- @cogitator-ai/core@0.18.3
- @cogitator-ai/neuro-symbolic@15.1.8

## 17.0.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/neuro-symbolic@15.1.7

## 17.0.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1
  - @cogitator-ai/neuro-symbolic@15.1.6

## 17.0.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/neuro-symbolic@15.1.5

## 17.0.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/neuro-symbolic@15.1.3

## 17.0.2

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/neuro-symbolic@15.1.2

## 17.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2
  - @cogitator-ai/neuro-symbolic@15.1.1

## 17.0.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/neuro-symbolic@15.1.0

## 16.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/core@0.17.1
  - @cogitator-ai/neuro-symbolic@15.0.1

## 16.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/neuro-symbolic@15.0.0

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/neuro-symbolic@14.0.0

## 14.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/neuro-symbolic@13.0.1

## 14.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/neuro-symbolic@13.0.0

## 13.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/neuro-symbolic@12.0.0

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/neuro-symbolic@11.0.0

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/neuro-symbolic@10.0.0

## 10.0.1

### Patch Changes

- @cogitator-ai/core@0.11.5
- @cogitator-ai/neuro-symbolic@9.1.1

## 10.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/neuro-symbolic@9.1.0

## 9.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/core@0.11.4
  - @cogitator-ai/neuro-symbolic@9.0.1

## 9.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/core@0.11.3
  - @cogitator-ai/neuro-symbolic@9.0.0

## 8.0.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/core@0.11.2
  - @cogitator-ai/neuro-symbolic@8.0.2

## 8.0.1

### Patch Changes

- @cogitator-ai/core@0.11.1
- @cogitator-ai/neuro-symbolic@8.0.1

## 8.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/neuro-symbolic@8.0.0

## 7.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/neuro-symbolic@7.0.0

## 6.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/neuro-symbolic@6.0.0

## 5.0.0

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/neuro-symbolic@5.0.0

## 4.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/neuro-symbolic@4.0.0

## 3.0.1

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1
  - @cogitator-ai/neuro-symbolic@3.0.1

## 3.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/neuro-symbolic@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [004cce0]
  - @cogitator-ai/neuro-symbolic@2.0.1

## 2.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/neuro-symbolic@2.0.0

## 1.0.0

### Minor Changes

- 05de0f1: feat(self-modifying): add Self-Modifying Agents package

  Initial release of @cogitator-ai/self-modifying with comprehensive capabilities:

  **Tool Self-Generation**
  - GapAnalyzer: Detects missing capabilities by comparing user intent with available tools
  - ToolGenerator: LLM-based synthesis of new tools at runtime
  - ToolValidator: Security scanning + correctness validation
  - ToolSandbox: Safe execution environment for generated tools
  - InMemoryGeneratedToolStore: Persistence and learning from tool usage

  **Meta-Reasoning**
  - MetaReasoner: Core metacognitive layer monitoring agent's reasoning
  - StrategySelector: Dynamic reasoning mode switching (analytical, creative, systematic, etc.)
  - ObservationCollector: Real-time metrics gathering for reasoning quality

  **Architecture Evolution**
  - CapabilityAnalyzer: Task profiling and complexity estimation
  - EvolutionStrategy: Selection algorithms (UCB, Thompson sampling, epsilon-greedy)
  - ParameterOptimizer: Multi-armed bandit optimization for model parameters

  **Constraints & Safety**
  - ModificationValidator: Constraint checking for all self-modifications
  - RollbackManager: Checkpoint and undo system for safe experimentation
  - Default safety constraints preventing arbitrary code execution and infinite loops

  **Event System**
  - SelfModifyingEventEmitter: Observability events for all self-modification activities

  Also adds new types to @cogitator-ai/types for self-modifying capabilities.

### Patch Changes

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

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/neuro-symbolic@1.0.0
