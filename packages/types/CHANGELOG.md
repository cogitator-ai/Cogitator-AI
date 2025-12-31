# @cogitator-ai/types

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
