# @cogitator-ai/self-modifying

Self-modifying agents for Cogitator. Agents that evolve at runtime — generating new tools, adapting reasoning strategies, and optimizing their own architecture.

## Installation

```bash
pnpm add @cogitator-ai/self-modifying
```

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { SelfModifyingAgent } from '@cogitator-ai/self-modifying';

const cogitator = new Cogitator({ defaultModel: 'gpt-4o' });
const agent = new Agent({
  name: 'adaptive-assistant',
  instructions: 'Solve problems adaptively.',
});

const selfModifying = new SelfModifyingAgent({
  agent,
  llm: cogitator.getDefaultBackend(),
  config: {
    toolGeneration: { enabled: true, autoGenerate: true },
    metaReasoning: { enabled: true },
    architectureEvolution: { enabled: true },
    constraints: { enabled: true, autoRollback: true },
  },
});

const result = await selfModifying.run('Analyze this CSV and visualize trends');

console.log('Output:', result.output);
console.log('Tools generated:', result.toolsGenerated.length);
console.log('Adaptations made:', result.adaptationsMade.length);
```

## Features

- **Tool Self-Generation** — Detects missing capabilities and synthesizes new tools at runtime
- **Meta-Reasoning** — Monitors reasoning process and switches between modes (analytical, creative, systematic)
- **Architecture Evolution** — Optimizes model, temperature, tool strategy using multi-armed bandits
- **Constraint Validation** — Safety checks prevent unsafe modifications
- **Rollback System** — Checkpoint before changes, auto-revert on performance decline
- **Event System** — Subscribe to all self-modification events for observability

---

## Tool Self-Generation

When the agent encounters a task requiring capabilities it doesn't have, it can generate new tools at runtime.

### How It Works

1. **Gap Analysis** — LLM compares user intent with available tools, identifies missing capabilities
2. **Code Synthesis** — Generates safe TypeScript tool implementation
3. **Validation** — Security scanning + correctness testing in sandbox
4. **Registration** — Valid tools are added to the agent's toolkit

### Configuration

```typescript
const selfModifying = new SelfModifyingAgent({
  agent,
  llm,
  config: {
    toolGeneration: {
      enabled: true,
      autoGenerate: true, // Auto-create tools when gaps detected
      maxToolsPerSession: 3, // Limit tools per run
      minConfidenceForGeneration: 0.7, // Threshold for generating
      maxIterationsPerTool: 3, // Max refinement attempts
      requireLLMValidation: true, // LLM validates generated code
      sandboxConfig: {
        enabled: true,
        maxExecutionTime: 5000, // 5s timeout
        maxMemory: 50 * 1024 * 1024, // 50MB limit
        allowedModules: [], // No external modules
        isolationLevel: 'strict',
      },
    },
  },
});
```

### Manual Tool Generation

```typescript
import { GapAnalyzer, ToolGenerator } from '@cogitator-ai/self-modifying';

const gapAnalyzer = new GapAnalyzer({ llm, config: toolGenConfig });
const toolGenerator = new ToolGenerator({ llm, config: toolGenConfig });

// Analyze what's missing
const analysis = await gapAnalyzer.analyze(
  'Calculate compound interest over 10 years',
  existingTools
);

console.log('Gaps found:', analysis.gaps.length);

// Generate tool for each gap
for (const gap of analysis.gaps) {
  const result = await toolGenerator.generate(gap, existingTools);
  if (result.success && result.tool) {
    console.log('Generated:', result.tool.name);
  }
}
```

### Generated Tool Store

```typescript
import { InMemoryGeneratedToolStore } from '@cogitator-ai/self-modifying';

const store = new InMemoryGeneratedToolStore();

// Save generated tool
await store.save(generatedTool);

// Record usage for learning
await store.recordUsage({
  toolId: tool.id,
  timestamp: new Date(),
  success: true,
  executionTime: 150,
});

// List active tools
const tools = await store.list({ status: 'active' });

// Find similar tools
const similar = await store.findSimilar('calculate interest');
```

---

## Meta-Reasoning

The meta-reasoning layer monitors the agent's reasoning process and makes strategic adjustments.

### Reasoning Modes

| Mode          | Temperature | Use Case                    |
| ------------- | ----------- | --------------------------- |
| `analytical`  | 0.3         | Logical analysis, debugging |
| `creative`    | 0.9         | Brainstorming, ideation     |
| `systematic`  | 0.2         | Step-by-step procedures     |
| `intuitive`   | 0.6         | Quick decisions, heuristics |
| `reflective`  | 0.4         | Self-assessment, learning   |
| `exploratory` | 0.7         | Open-ended exploration      |

### Configuration

```typescript
const selfModifying = new SelfModifyingAgent({
  agent,
  llm,
  config: {
    metaReasoning: {
      enabled: true,
      defaultMode: 'analytical',
      allowedModes: [
        'analytical',
        'creative',
        'systematic',
        'intuitive',
        'reflective',
        'exploratory',
      ],
      modeProfiles: {
        analytical: { mode: 'analytical', temperature: 0.3, depth: 3 },
        creative: { mode: 'creative', temperature: 0.9, depth: 2 },
        // ... other modes
      },
      maxMetaAssessments: 5, // Max assessments per run
      maxAdaptations: 3, // Max mode switches per run
      metaAssessmentCooldown: 10000, // 10s between assessments
      adaptationCooldown: 15000, // 15s between adaptations
      triggers: ['on_failure', 'on_low_confidence', 'periodic'],
      triggerAfterIterations: 3, // Assess every 3 iterations
      triggerOnConfidenceDrop: 0.3, // Assess if confidence < 30%
      triggerOnProgressStall: 2, // Assess after 2 stalled iterations
      minConfidenceToAdapt: 0.6, // Min confidence to apply change
      enableRollback: true,
      rollbackWindow: 30000, // 30s rollback window
      rollbackOnDecline: true, // Auto-rollback if metrics decline
    },
  },
});
```

### Meta-Reasoning Process

1. **Observation** — Collect metrics (progress, confidence, tokens, time)
2. **Assessment** — LLM analyzes if reasoning is on-track
3. **Adaptation** — Switch mode or adjust parameters if needed
4. **Rollback** — Revert if metrics decline after adaptation

### Direct MetaReasoner Usage

```typescript
import { MetaReasoner } from '@cogitator-ai/self-modifying';

const metaReasoner = new MetaReasoner({
  llm,
  model: 'gpt-4o',
  config: metaReasoningConfig,
});

// Initialize run
const modeConfig = metaReasoner.initializeRun(runId);

// Observe current state
const observation = metaReasoner.observe(
  {
    runId,
    iteration: 3,
    goal: 'Analyze data',
    currentMode: 'analytical',
    tokensUsed: 1500,
    timeElapsed: 5000,
    iterationsRemaining: 7,
    budgetRemaining: 8500,
  },
  insights
);

// Assess if on-track
const assessment = await metaReasoner.assess(observation);

console.log('On track:', assessment.onTrack);
console.log('Issues:', assessment.issues);
console.log('Recommendation:', assessment.recommendation);

// Apply adaptation if needed
if (assessment.requiresAdaptation) {
  const adaptation = await metaReasoner.adapt(runId, assessment);
  console.log('Switched to:', adaptation?.after?.mode);
}

// Rollback if needed
const rollback = metaReasoner.rollback(runId);
```

---

## Architecture Evolution

Optimizes agent parameters (model, temperature, tool strategy) using multi-armed bandit algorithms.

### Strategies

| Strategy         | Description                                    |
| ---------------- | ---------------------------------------------- |
| `ucb`            | Upper Confidence Bound — balanced exploration  |
| `thompson`       | Thompson Sampling — probabilistic selection    |
| `epsilon_greedy` | Epsilon-Greedy — random exploration with decay |

### Configuration

```typescript
const selfModifying = new SelfModifyingAgent({
  agent,
  llm,
  config: {
    architectureEvolution: {
      enabled: true,
      strategy: {
        type: 'ucb',
        explorationConstant: 2, // Higher = more exploration
      },
      // Or Thompson sampling:
      // strategy: { type: 'thompson', priorAlpha: 1, priorBeta: 1 },
      // Or epsilon-greedy:
      // strategy: { type: 'epsilon_greedy', epsilon: 0.1, decayRate: 0.99 },

      maxCandidates: 10, // Max configs to track
      evaluationWindow: 10, // Runs to consider for metrics
      minEvaluationsBeforeEvolution: 3, // Min runs before switching
      adaptationThreshold: 0.1, // Min improvement to switch
    },
  },
});
```

### Parameter Optimizer

```typescript
import { ParameterOptimizer } from '@cogitator-ai/self-modifying';

const optimizer = new ParameterOptimizer({
  llm,
  config: evolutionConfig,
  baseConfig: {
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 4096,
    toolStrategy: 'sequential',
    reflectionDepth: 1,
  },
});

// Optimize for a task
const result = await optimizer.optimize('Complex reasoning task');

console.log('Should adopt:', result.shouldAdopt);
console.log('Confidence:', result.confidence);
console.log('Recommended config:', result.recommendedConfig);
console.log('Reasoning:', result.reasoning);

// Record outcome for learning
optimizer.recordOutcome(result.candidate!.id, 0.85);
```

### Capability Analyzer

```typescript
import { CapabilityAnalyzer } from '@cogitator-ai/self-modifying';

const analyzer = new CapabilityAnalyzer({
  llm,
  enableLLMAnalysis: true,
});

const profile = await analyzer.analyze('Build a REST API with authentication');

console.log('Complexity:', profile.complexity); // 'complex'
console.log('Domain:', profile.domain); // 'coding'
console.log('Tool intensity:', profile.toolIntensity); // 'heavy'
console.log('Reasoning depth:', profile.reasoningDepth); // 'deep'
console.log('Estimated tokens:', profile.estimatedTokens);
```

---

## Constraints & Safety

All self-modifications are validated against safety constraints before being applied.

### Default Constraints

```typescript
import {
  DEFAULT_SAFETY_CONSTRAINTS,
  DEFAULT_CAPABILITY_CONSTRAINTS,
  DEFAULT_RESOURCE_CONSTRAINTS,
} from '@cogitator-ai/self-modifying';

// Safety: prevent dangerous operations
// - no_arbitrary_code: Sandbox execution required
// - max_tool_complexity: Lines of code < 100
// - no_self_modification_loop: Modification depth < 3

// Capability: prevent degradation
// - min_tool_count: At least 1 tool
// - max_tool_count: At most 20 tools
// - required_capabilities: Core capabilities preserved

// Resource: prevent runaway costs
// - max_tokens_per_run: Token budget
// - max_time_per_run: Time limit
// - max_cost_per_run: Cost limit
```

### Modification Validator

```typescript
import { ModificationValidator } from '@cogitator-ai/self-modifying';

const validator = new ModificationValidator({
  constraints: {
    safety: DEFAULT_SAFETY_CONSTRAINTS,
    capability: DEFAULT_CAPABILITY_CONSTRAINTS,
    resource: DEFAULT_RESOURCE_CONSTRAINTS,
    custom: [
      {
        id: 'no-external-apis',
        name: 'No External APIs',
        check: (mod) => !mod.changes?.usesExternalApi,
        errorMessage: 'External API calls not allowed',
        severity: 'error',
      },
    ],
  },
});

const result = await validator.validate({
  type: 'tool_addition',
  target: 'tools',
  changes: { name: 'new-tool', code: '...' },
  reason: 'User requested capability',
});

console.log('Valid:', result.valid);
console.log('Warnings:', result.warnings);
console.log('Errors:', result.errors);
```

### Rollback Manager

```typescript
import { RollbackManager } from '@cogitator-ai/self-modifying';

const rollbackManager = new RollbackManager({
  maxCheckpoints: 10,
});

// Create checkpoint before modification
const checkpoint = await rollbackManager.createCheckpoint(
  agentName,
  agentConfig,
  currentTools,
  modifications
);

console.log('Checkpoint:', checkpoint.id);

// Rollback if something goes wrong
const restored = await rollbackManager.rollbackTo(checkpoint.id);

if (restored) {
  console.log('Restored config:', restored.agentConfig);
  console.log('Restored tools:', restored.tools.length);
}

// List checkpoints
const checkpoints = rollbackManager.listCheckpoints();
```

---

## Events

Subscribe to self-modification events for observability.

```typescript
const selfModifying = new SelfModifyingAgent({ agent, llm, config });

// Tool generation events
selfModifying.on('tool_generation_started', (e) => {
  console.log('Generating tool for gap:', e.data.gap.suggestedToolName);
});

selfModifying.on('tool_generation_completed', (e) => {
  console.log('Tool created:', e.data.name, 'success:', e.data.success);
});

// Meta-reasoning events
selfModifying.on('meta_assessment', (e) => {
  console.log('Assessment:', e.data.assessment.onTrack ? 'on-track' : 'off-track');
});

selfModifying.on('strategy_changed', (e) => {
  console.log(`Mode: ${e.data.previousMode} → ${e.data.newMode}`);
});

// Architecture events
selfModifying.on('architecture_evolved', (e) => {
  console.log('New config:', e.data.changes);
});

// Checkpoint events
selfModifying.on('checkpoint_created', (e) => {
  console.log('Checkpoint:', e.data.checkpointId);
});

selfModifying.on('rollback_performed', (e) => {
  console.log('Rolled back to:', e.data.checkpointId);
});

// Run lifecycle
selfModifying.on('run_started', (e) => {
  console.log('Run started:', e.runId);
});

selfModifying.on('run_completed', (e) => {
  console.log('Run completed:', e.data.success);
});
```

### Event Types

| Event                       | Description                     |
| --------------------------- | ------------------------------- |
| `run_started`               | Self-modifying run started      |
| `run_completed`             | Run completed (success/failure) |
| `tool_generation_started`   | Started generating a new tool   |
| `tool_generation_completed` | Tool generation finished        |
| `meta_assessment`           | Meta-reasoning assessment made  |
| `strategy_changed`          | Reasoning mode switched         |
| `architecture_evolved`      | Architecture config changed     |
| `checkpoint_created`        | Rollback checkpoint created     |
| `rollback_performed`        | Rolled back to checkpoint       |

---

## Checkpoints & Rollback

Create checkpoints and rollback to safe states.

```typescript
const selfModifying = new SelfModifyingAgent({ agent, llm, config });

// Run with checkpointing
const result = await selfModifying.run('Complex task...');

// Manual checkpoint during run
selfModifying.on('strategy_changed', async () => {
  const checkpoint = await selfModifying.createCheckpoint();
  console.log('Saved state:', checkpoint?.id);
});

// Rollback to previous state
const success = await selfModifying.rollbackToCheckpoint(checkpointId);
console.log('Rollback success:', success);

// Get generated tools
const tools = await selfModifying.getGeneratedTools();
console.log('Active tools:', tools.length);

// Record tool usage for learning
await selfModifying.recordToolUsage(toolId, true, 150);
```

---

## Type Reference

### Core Types

```typescript
import type {
  SelfModifyingConfig,
  ToolSelfGenerationConfig,
  MetaReasoningConfig,
  ArchitectureEvolutionConfig,
} from '@cogitator-ai/types';
```

### Tool Generation Types

```typescript
import type {
  CapabilityGap,
  GapAnalysisResult,
  GeneratedTool,
  ToolValidationResult,
  ToolSandboxConfig,
  ToolSandboxResult,
} from '@cogitator-ai/types';
```

### Meta-Reasoning Types

```typescript
import type {
  ReasoningMode,
  ReasoningModeConfig,
  MetaObservation,
  MetaAssessment,
  MetaAdaptation,
  MetaRecommendation,
  MetaTrigger,
} from '@cogitator-ai/types';
```

### Architecture Evolution Types

```typescript
import type {
  TaskProfile,
  ArchitectureConfig,
  EvolutionCandidate,
  EvolutionStrategy,
} from '@cogitator-ai/types';
```

### Constraint Types

```typescript
import type {
  SafetyConstraint,
  CapabilityConstraint,
  ResourceConstraint,
  ModificationConstraints,
  ModificationValidationResult,
  ModificationCheckpoint,
} from '@cogitator-ai/types';
```

### Event Types

```typescript
import type {
  SelfModifyingEvent,
  SelfModifyingEventType,
  SelfModifyingEventHandler,
} from '@cogitator-ai/types';
```

---

## Examples

### Adaptive Data Analyst

```typescript
const analyst = new Agent({
  name: 'data-analyst',
  instructions: 'Analyze data and create visualizations.',
  tools: [readFile],
});

const selfModifying = new SelfModifyingAgent({
  agent: analyst,
  llm,
  config: {
    toolGeneration: {
      enabled: true,
      autoGenerate: true,
      maxToolsPerSession: 5,
    },
    metaReasoning: {
      enabled: true,
      defaultMode: 'analytical',
      triggers: ['on_failure', 'periodic'],
    },
  },
});

// Will auto-generate CSV parser, statistics calculator, chart generator as needed
const result = await selfModifying.run(
  'Load sales.csv, calculate monthly trends, and create a bar chart'
);

console.log(
  'Generated tools:',
  result.toolsGenerated.map((t) => t.name)
);
// ['csv_parser', 'trend_calculator', 'bar_chart_generator']
```

### Creative Problem Solver

```typescript
const solver = new Agent({
  name: 'problem-solver',
  instructions: 'Find creative solutions to complex problems.',
});

const selfModifying = new SelfModifyingAgent({
  agent: solver,
  llm,
  config: {
    metaReasoning: {
      enabled: true,
      defaultMode: 'systematic',
      allowedModes: ['systematic', 'creative', 'analytical'],
      triggerOnProgressStall: 2,
    },
    architectureEvolution: {
      enabled: true,
      strategy: { type: 'thompson' },
    },
  },
});

// Will switch from systematic → creative if stuck
const result = await selfModifying.run(
  'Design a novel approach to reduce carbon emissions in cities'
);

console.log('Mode changes:', result.adaptationsMade.length);
console.log('Final mode:', result.finalConfig.toolStrategy);
```

### Safe Code Generator

```typescript
const coder = new Agent({
  name: 'code-generator',
  instructions: 'Generate safe, tested code.',
});

const selfModifying = new SelfModifyingAgent({
  agent: coder,
  llm,
  config: {
    toolGeneration: {
      enabled: true,
      sandboxConfig: {
        enabled: true,
        maxExecutionTime: 3000,
        isolationLevel: 'strict',
        allowedModules: [],
      },
    },
    constraints: {
      enabled: true,
      autoRollback: true,
      maxModificationsPerRun: 5,
    },
  },
});

// All generated tools are sandboxed and validated
selfModifying.on('tool_generation_completed', (e) => {
  if (!e.data.success) {
    console.log('Tool rejected:', e.data.error);
  }
});

const result = await selfModifying.run('Create a utility to parse JSON safely');
```

---

## License

MIT
