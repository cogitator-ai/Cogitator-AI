---
'@cogitator-ai/self-modifying': minor
'@cogitator-ai/types': patch
---

feat(self-modifying): add Self-Modifying Agents package

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
