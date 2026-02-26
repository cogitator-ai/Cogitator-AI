# @cogitator-ai/self-modifying

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
