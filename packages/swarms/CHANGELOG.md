# @cogitator-ai/swarms

## 0.12.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Cancellation now reaches the agent runs of swarms and queued jobs.

  - `SwarmRunOptions.signal` cancels a swarm run and aborts its agent turns in flight. `swarmNode`, `conditionalSwarmNode` and `parallelSwarmsNode` pass the workflow run's signal, so a node timeout, pause or cancel stops the swarm (it ran to the end before), and a retry of the node no longer fails with "Swarm is already running"
  - `WorkerPool` hands the abort signal BullMQ gives each job to its agent runs, workflow nodes and swarm turns. `pool.cancelJob(jobId)` stops a running job, and `stop()` aborts the jobs still running when its timeout runs out instead of letting them run on without a lock while another worker picks them up. The processors take `{ signal }` as a third argument
  - Distributed swarm turns that the swarm gave up on no longer run later: every retry of a turn reuses its job id and payload, a timed-out copy still queued is removed before the next push, and an aborted, timed-out or closed turn is taken off the queue and added to a cancelled set that `DistributedSwarmWorker` checks before and while it runs a turn (`cancelCheckInterval`, `onJobCancelled`)

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Agents travel to other processes in one complete wire format. `toAgentWire(agent)` and `fromAgentWire(payload, { cogitator, tools })` in `@cogitator-ai/core` carry every `AgentConfig` field (stop sequences, timeout, handoff graphs, the response schema as JSON Schema and the rest) and route the model exactly as the sender would, and `toAgentWireRunResult` / `fromAgentWireRunResult` carry a run's outcome with its cost, duration and the `truncated`, `blocked` and `iterationLimitReached` flags. Worker agent, workflow and swarm jobs (`serializeAgent`, `SerializedAgent`) and distributed swarm turns now use them, which fixes several silent losses:

  - an agent with an explicit `provider` (`{ model: 'openai/gpt-5', provider: 'openrouter' }`) ran on a different provider after `serializeAgent`
  - `timeout`, `stopSequences` and `handoffs` were dropped by `serializeAgent`, so a long job failed at 120 s and a triage agent answered itself
  - agent nodes of worker workflow jobs dropped `responseFormat`, `topP` and `reasoning`, and now write the structured answer of a JSON schema agent to the state
  - distributed swarm turns dropped `responseFormat`, `reasoning`, `topP` and `onIterationLimit`, and reported cost 0 without `truncated`, so `resources.costLimit` never stopped a swarm and the debate retry of a reasoning-starved turn never ran

  A config with a key the receiving side does not know is now refused instead of run without that setting.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - An agent run that pauses for tool approvals no longer passes for a finished run in queues, workflows and swarms.

  - Worker agent jobs complete with `status: 'paused'`, the waiting calls and the checkpoint, and `JobQueue.resumeAgentJob(agentConfig, pausedResult, { decisions })` continues the run on any worker. Workflow and swarm jobs whose agent pauses fail without retries with an `AgentRunPausedError` instead of handing the model's text before the tool call to the next node.
  - `agentNode` asks for the waiting calls through the workflow's human-in-the-loop approval store (the `approvalStore` execute option, shaped by the new `approvals` option) and resumes the run once they are answered. Without a store, or with `approvals: false`, the node fails with an `AgentRunPausedError` that carries the checkpoint, and the executor does not retry it.
  - A swarm turn that pauses, local or distributed, fails with an `AgentRunPausedError` instead of answering with the pre-tool text. It is not retried, skipped or failed over and does not trip the circuit breaker.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Swarm topologies do what they say. The `collaborative` topology of worker swarm jobs ran only the first agent (it mapped to round-robin): now every agent contributes in each of `maxRounds` rounds (default 3), seeing the task and all contributions so far, and the `coordinator`, when given, combines them into the answer. The job reports every contribution in `agentOutputs` and the rounds it ran. Distributed swarms now refuse the hierarchical and negotiation strategies, whose delegation and offer tools only exist in-process, instead of letting the supervisor answer by itself. The JSDoc of `JobQueue.addSwarmAgentJob` no longer claims that distributed swarms use it: their turns go to `DistributedSwarmWorker`.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/workflows@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/workflows@0.11.10

## 0.11.0

### Minor Changes

- [#123](https://github.com/cogitator-ai/Cogitator-AI/pull/123) [`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774) - A debate turn of a reasoning model no longer comes back empty under a short `maxTokensPerTurn`. Providers count reasoning in the same output limit as the answer, so a model that reasoned past the limit returned an empty or cut-off turn. Now a turn the model spent thinking, its answer stopped at the limit or came back empty after reasoning with less than half the limit in visible text, is run once more with room to reason on top: 4096 tokens or twice what it reasoned. The check works on every provider, including those that report no reasoning tokens. A model that does not reason keeps the limit as it is, and a turn that called tools is never run again. The new `DebateConfig.reasoningTokensPerTurn` gives the room from the first try; debaters are asked to keep their answer to `maxTokensPerTurn`, since providers cannot cap the answer apart from the reasoning.

  `RunResult.truncated` is `true` when the model's last answer stopped at the output token limit.

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0
  - @cogitator-ai/workflows@0.11.9

## 0.10.8

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/workflows@0.11.8

## 0.10.7

### Patch Changes

- Updated dependencies [[`a34d4f9`](https://github.com/cogitator-ai/Cogitator-AI/commit/a34d4f97a970b8df2c2d45ef78dc4a3243f3e62b)]:
  - @cogitator-ai/workflows@0.11.7

## 0.10.6

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4
  - @cogitator-ai/workflows@0.11.6

## 0.10.5

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3
  - @cogitator-ai/workflows@0.11.5

## 0.10.4

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/types@0.33.1
  - @cogitator-ai/workflows@0.11.4

## 0.10.3

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/workflows@0.11.3

## 0.10.2

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/workflows@0.11.2

## 0.10.1

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/workflows@0.11.1

## 0.10.0

### Minor Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Debate turns name their speaker. The transcript that debaters and the moderator read labelled every turn by role, so with all debaters advocates it read "[advocate]: ..." throughout and nobody could tell who said what. Turns are now labelled with the speaker's name and its role when it has one. A new `synthesisPrompt` on `DebateConfig` replaces the moderator's fixed "summarise both sides" task, with `{topic}` and `{transcript}` filled in, for callers who want their own decision step. The `maxTokensPerTurn` docs now say that a reasoning model spends its reasoning from that budget, which left turns empty or cut off at a few hundred tokens.

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/workflows@0.11.0

## 0.9.3

### Patch Changes

- [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe) - Distributed swarm turns run on the model the agent would use in-process. The coordinator sent `provider: 'ollama'` for every agent whose model had no built-in provider prefix, so a worker ran `openrouter/deepseek/deepseek-v4-pro` as `ollama/openrouter/...` instead of on its `openrouter` backend. The job payload now carries the agent's model as is, prefixed with the agent's own `provider` only when the agent sets one (an explicit provider gets the model string unchanged, as in-process), and `SerializedSwarmAgentConfig.provider` is optional.
- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2), [`cdc2b80`](https://github.com/cogitator-ai/Cogitator-AI/commit/cdc2b801b6914b50318d080b0eba5d8547b7c23a)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/workflows@0.10.3

## 0.9.2

### Patch Changes

- Updated dependencies [[`c237c48`](https://github.com/cogitator-ai/Cogitator-AI/commit/c237c4836c654c3521c82bb11d3f0ccf4ed3a78f), [`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/workflows@0.10.2
  - @cogitator-ai/core@0.26.2

## 0.9.1

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/workflows@0.10.1

## 0.9.0

### Minor Changes

- e2da4f9: Consensus voters get the `cast_vote`, `get_votes`, `change_vote` and `get_consensus_status` tools automatically (they were never attached, so votes could only be parsed from text). New `agentTools: { messaging, blackboard }` swarm option (and `SwarmBuilder.agentTools()`) gives every agent the built-in messaging and blackboard tools; it is rejected for distributed swarms and when the message bus or blackboard is disabled.
- e2da4f9: The assessor honours `mode: 'ai' | 'hybrid'` and `assessorModel`: inside a Swarm the model (default: the Cogitator's default model) analyzes the task, 'hybrid' adds the hard requirements the keyword rules detect, and any failure falls back to the rules with a warning. Model discovery inside a Swarm only offers cloud models whose provider the Cogitator can run, instead of suggesting providers without an API key. `createAssessor(config, cogitator)` takes the Cogitator for the same behaviour standalone.
- e2da4f9: Negotiation approval gates work inside a `Swarm`: a gate without `timeout` now waits for an answer instead of being rejected at once, and the new `swarm.respondToApproval(requestId, response)` answers it (the id comes with the `negotiation:approval-required` event). A swarm timeout or `swarm.abort()` stops the wait. Gates on a deadlock were also cancelled the moment they were raised; they now wait for their answer or timeout.
- 0e17a89: A swarm run that timed out or failed rejected while its strategy kept going, and the strategy could still start agents and retries afterwards — even inside the next run of the same swarm. Agent runs are now bound to the run that started them (`SwarmCoordinator.runInScope`), and a run that rejects cancels its scope, so nothing of it launches once `run()` has settled.

### Patch Changes

- e2da4f9: Swarm config fields that were accepted but ignored now work or say why they cannot: `observability.tracing` logs each agent run's spans, `distributed.retry` re-dispatches jobs that fail on a worker or time out, and `distributed.cleanupAfter` expires the swarm's Redis state after `close()` (default one hour). `messaging.protocol` (now optional), `blackboard.locking` and `distributed.workerConcurrency` have no effect and are marked deprecated with the reason. `swarm.messageBus` and `swarm.events` are typed with their full API (`markAsRead`, `onMessage`, `getEventsByType`, `getEventsByAgent`).
- e2da4f9: A pipeline swarm configured with the top-level `stages` field runs (it was rejected because only `pipeline.stages` was read); `gates` and `stageInput` still come from `pipeline`. Giving different stages in both places is rejected with a clear error.
- 6b7e672: Round-robin with `sticky: true` advances its rotation again: a known `stickyKey` stays with the agent that handled it first, while every new key goes to the next agent (before, the rotation never moved, so all keys landed on the first agent). Without a `stickyKey`, runs rotate normally. The `round-robin:assigned` event reports the index of the agent that was picked.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [e7445e2]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
- Updated dependencies [25af97f]
- Updated dependencies [1a41760]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0
  - @cogitator-ai/workflows@0.10.0

## 0.8.2

### Patch Changes

- Updated dependencies [3d08d05]
- Updated dependencies [e211b6a]
- Updated dependencies [4c46b22]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [802388e]
- Updated dependencies [8d2d1bf]
- Updated dependencies [35701f9]
  - @cogitator-ai/workflows@0.9.0
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/types@0.28.0

## 0.8.1

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/workflows@0.8.0

## 0.8.0

### Minor Changes

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
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/workflows@0.7.3

## 0.7.0

### Minor Changes

- 6404340: `llm.defaultModel` and `limits` now do what they say.

  - An agent may leave out `model` (`AgentConfig.model` is optional): it runs on the Cogitator's `llm.defaultModel`, and a run without either fails with a `CONFIGURATION_ERROR` naming the agent. `cogitator.resolveModel(agent)` returns the model a run uses. **Breaking for types:** `Agent.model` is `string | undefined`.
  - `limits.maxConcurrentRuns` caps concurrent `run()` calls; the rest wait in order, and their timeout and abort signal cover the wait.
  - `limits.defaultTimeout` applies to runs whose options and agent set no timeout. The 120 s default moved from the `Agent` constructor to the runtime, so `agent.config.timeout` is `undefined` unless set.
  - `limits.maxTokensPerRun` is checked before every model call and fails the run with the new `RUN_TOKEN_LIMIT_EXCEEDED` code.
  - Swarms: the assessor and the distributed coordinator resolve models through the Cogitator, so agents without a model work there too (`Assessor.analyze()` takes an optional resolver).

### Patch Changes

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/workflows@0.7.2

## 0.6.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/workflows@0.7.1

## 0.6.0

### Minor Changes

- Model discovery and scoring know current models (GPT-6, Claude 5.5, Gemini 3.x, qwen3); `llama3` no longer claims tool support; ioredis 6.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0
  - @cogitator-ai/workflows@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.6.1

## 0.5.0

### Minor Changes

- Distributed swarms had never worked. They now use a Redis-list job protocol with jobId matching and lazy connection, and run end to end with the worker's DistributedSwarmWorker. Shared coordinator logic moved into a new BaseSwarmCoordinator, which adds retry and failover without recursion, abort and timeout signals (SwarmTimeoutError), per-run and per-turn token budgets, and a concurrency pool. Several strategies were broken and are fixed: hierarchical delegation through the plain Swarm API, consensus ties and abstentions, pipeline first-stage retry, debate token caps, and negotiation agreement through tools. Supervisors and negotiators now get their strategy tools automatically. Communication now has read tracking, exactly-once delivery and isolated handlers. The assessor returns provider-qualified models. README, dashboard swarm docs and swarm examples 01/03/04 were rewritten or fixed and verified with Gemini.

  **Breaking changes**
  - Swarm.reset() now returns Promise<void>
  - Assessment assignedModel is provider-qualified (e.g. 'ollama/qwen2.5:0.5b')
  - Consensus threshold is measured against all eligible voters, not just the votes cast
  - Registering two different agents with the same name throws
  - SwarmAgentJobPayload.agentConfig is now SerializedSwarmAgentConfig and the payload gains runOptions
  - Swarm examples import types from @cogitator-ai/swarms; scripts/test.sh removed and the test script is now 'vitest run'

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0
  - @cogitator-ai/workflows@0.6.0

## 0.4.20

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
  - @cogitator-ai/workflows@0.5.17
  - @cogitator-ai/types@0.22.3

## 0.4.19

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/workflows@0.5.16

## 0.4.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/workflows@0.5.15

## 0.4.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/workflows@0.5.14

## 0.4.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7
  - @cogitator-ai/workflows@0.5.12

## 0.4.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6
  - @cogitator-ai/workflows@0.5.11

## 0.4.14

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
  - @cogitator-ai/workflows@0.5.10

## 0.4.13

### Patch Changes

- fix(swarms): audit — 30+ bugs fixed, +121 tests, docs updated

  HIGH severity fixes:
  - swarm.ts: validateConfig missing 'negotiation' strategy + SwarmBuilder missing negotiation() method
  - coordinator.ts: inverted error handling in runAgentsParallel (abort/retry/failover silently skipped)
  - pipeline.ts: infinite retry loop (getRetryCount never incremented) + retry-previous wrong input
  - model-discovery.ts: first-match-wins → longest-match-wins for capability inference
  - voting.ts: duplicate votes allowed + weighted resolution ignored weights
  - negotiation.ts: rejectOffer missing authorization check
  - swarm-node.ts: unsafe cast without runtime check

  MEDIUM severity fixes:
  - coordinator.ts: pause loop ignores abort, unnecessary concrete type casts
  - model-discovery.ts: stale cloud model display names
  - round-robin.ts: currentIndex out of bounds
  - negotiation + voting + delegation: blackboard.read() throws vs null
  - assessor.ts: 15+ unnecessary as casts removed

## 0.4.12

### Patch Changes

- @cogitator-ai/core@0.18.4
- @cogitator-ai/workflows@0.5.9

## 0.4.11

### Patch Changes

- @cogitator-ai/core@0.18.3
- @cogitator-ai/workflows@0.5.8

## 0.4.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/workflows@0.5.7

## 0.4.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1
  - @cogitator-ai/workflows@0.5.6

## 0.4.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/workflows@0.5.5

## 0.4.6

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/workflows@0.5.3

## 0.4.5

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/workflows@0.5.2

## 0.4.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2
  - @cogitator-ai/workflows@0.5.1

## 0.4.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.5.0
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/core@0.17.1

## 0.4.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/workflows@0.4.7

## 0.4.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/workflows@0.4.6

## 0.4.0

### Minor Changes

- feat: distributed swarm execution via Redis

## 0.3.20

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/workflows@0.4.5

## 0.3.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/workflows@0.4.4

## 0.3.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/workflows@0.4.3

## 0.3.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/workflows@0.4.2

## 0.3.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.4.1
  - @cogitator-ai/core@0.11.5

## 0.3.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/workflows@0.4.0
  - @cogitator-ai/core@0.11.4

## 0.3.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/core@0.11.3
  - @cogitator-ai/workflows@0.3.1

## 0.3.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/workflows@0.3.0
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/core@0.11.2

## 0.3.12

### Patch Changes

- fec45e0: Add comprehensive execution tests for all 7 swarm strategies
  - Add mock infrastructure: MockCoordinator, mock-helpers
  - Add tests for RoundRobinStrategy: sequential/random rotation, sticky sessions
  - Add tests for HierarchicalStrategy: supervisor-worker delegation, worker info
  - Add tests for ConsensusStrategy: vote extraction, resolution methods, multiple rounds
  - Add tests for AuctionStrategy: bid parsing, winner selection, minBid filtering
  - Add tests for PipelineStrategy: sequential execution, gates, retry-previous, goto
  - Add tests for DebateStrategy: rounds, moderator synthesis, transcript
  - Add tests for NegotiationStrategy: phase progression, deadlock handling, convergence

## 0.3.11

### Patch Changes

- @cogitator-ai/core@0.11.1
- @cogitator-ai/workflows@0.2.11

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/workflows@0.2.10

## 0.3.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/workflows@0.2.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/workflows@0.2.8

## 0.3.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/workflows@0.2.7

## 0.3.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/workflows@0.2.6

## 0.3.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1
  - @cogitator-ai/workflows@0.2.5

## 0.3.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/workflows@0.2.4

## 0.3.3

### Patch Changes

- f874e69: ### Memory improvements
  - Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
  - Add Google embedding service using `text-embedding-004` model (768 dimensions)
  - Implement hybrid context strategy (30% semantic + 70% recent messages)
  - Fix foreign key constraint violation when saving entries before thread creation

  ### Swarms improvements
  - Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
  - Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
  - Fix coordinator to properly register pipeline stages and handle missing negotiation section

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/workflows@0.2.3

## 0.3.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/workflows@0.2.2

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/workflows@0.2.1

## 0.3.0

### Minor Changes

- Fix type safety: remove unsafe `as unknown as number` cast in AssessorConfig defaults
- Fix cost calculation: correctly compute savings when downgrading to local models
- Improve token estimation: use task complexity (simple/moderate/complex) for cost estimates
- Add proper error logging in event handlers (EventEmitter, MessageBus, Blackboard, CircuitBreaker)

### Bug Fixes

- Cost optimization now properly calculates the difference between old and new model costs
- Token estimates now vary by task complexity (500/1500/4000 tokens)

## 0.2.0

### Minor Changes

- feat(swarms): add AI Assessor for dynamic model casting

  Introduces the Assessor system that analyzes tasks and automatically assigns optimal models to each agent role before swarm execution.

  **New features:**
  - `SwarmBuilder.withAssessor()` - enable automatic model selection
  - `swarm.dryRun()` - preview model assignments without executing
  - `metadata.locked` - lock specific agents to prevent model changes
  - Local-first model preference (Ollama over cloud when capable)
  - Budget-aware cost optimization with `maxCostPerRun`

  **New exports from @cogitator-ai/swarms:**
  - `SwarmAssessor`, `createAssessor` - main assessor API
  - `TaskAnalyzer` - rule-based task analysis
  - `ModelDiscovery` - discover Ollama + cloud models
  - `ModelScorer` - score models against requirements
  - `RoleMatcher` - adjust requirements per agent role

  **Example usage:**

  ```typescript
  const swarm = new SwarmBuilder('research-team')
    .strategy('hierarchical')
    .supervisor(supervisorAgent)
    .workers([researcher, writer])
    .withAssessor({
      preferLocal: true,
      maxCostPerRun: 0.1,
    })
    .build(cogitator);

  // Preview assignments
  const preview = await swarm.dryRun({ input: 'Research task...' });

  // Models auto-assigned on first run
  const result = await swarm.run({ input: 'Research task...' });
  ```

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/core@0.1.1
  - @cogitator-ai/workflows@0.1.1
