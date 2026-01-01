import { describe, it, expect } from 'vitest';

describe('@cogitator-ai/self-modifying', () => {
  it('exports SelfModifyingAgent', async () => {
    const { SelfModifyingAgent } = await import('../index');
    expect(SelfModifyingAgent).toBeDefined();
  });

  it('exports tool generation components', async () => {
    const { GapAnalyzer, ToolGenerator, ToolValidator, ToolSandbox, InMemoryGeneratedToolStore } =
      await import('../index');

    expect(GapAnalyzer).toBeDefined();
    expect(ToolGenerator).toBeDefined();
    expect(ToolValidator).toBeDefined();
    expect(ToolSandbox).toBeDefined();
    expect(InMemoryGeneratedToolStore).toBeDefined();
  });

  it('exports meta-reasoning components', async () => {
    const { MetaReasoner, ObservationCollector, StrategySelector } = await import('../index');

    expect(MetaReasoner).toBeDefined();
    expect(ObservationCollector).toBeDefined();
    expect(StrategySelector).toBeDefined();
  });

  it('exports architecture evolution components', async () => {
    const { CapabilityAnalyzer, EvolutionStrategy, ParameterOptimizer } = await import('../index');

    expect(CapabilityAnalyzer).toBeDefined();
    expect(EvolutionStrategy).toBeDefined();
    expect(ParameterOptimizer).toBeDefined();
  });

  it('exports constraints components', async () => {
    const {
      ModificationValidator,
      RollbackManager,
      InMemoryCheckpointStore,
      DEFAULT_SAFETY_CONSTRAINTS,
    } = await import('../index');

    expect(ModificationValidator).toBeDefined();
    expect(RollbackManager).toBeDefined();
    expect(InMemoryCheckpointStore).toBeDefined();
    expect(DEFAULT_SAFETY_CONSTRAINTS).toBeDefined();
  });

  it('exports events components', async () => {
    const { SelfModifyingEventEmitter } = await import('../index');
    expect(SelfModifyingEventEmitter).toBeDefined();
  });

  it('exports default configs', async () => {
    const {
      DEFAULT_SANDBOX_CONFIG,
      DEFAULT_META_REASONING_CONFIG,
      DEFAULT_MODE_PROFILES,
      DEFAULT_SAFETY_CONSTRAINTS,
      DEFAULT_CAPABILITY_CONSTRAINTS,
      DEFAULT_RESOURCE_CONSTRAINTS,
    } = await import('../index');

    expect(DEFAULT_SANDBOX_CONFIG).toBeDefined();
    expect(DEFAULT_META_REASONING_CONFIG).toBeDefined();
    expect(DEFAULT_MODE_PROFILES).toBeDefined();
    expect(DEFAULT_SAFETY_CONSTRAINTS).toBeDefined();
    expect(DEFAULT_CAPABILITY_CONSTRAINTS).toBeDefined();
    expect(DEFAULT_RESOURCE_CONSTRAINTS).toBeDefined();
  });

  it('exports prompt builders', async () => {
    const {
      buildGapAnalysisPrompt,
      buildToolGenerationPrompt,
      buildMetaAssessmentPrompt,
      buildTaskProfilePrompt,
    } = await import('../index');

    expect(buildGapAnalysisPrompt).toBeDefined();
    expect(buildToolGenerationPrompt).toBeDefined();
    expect(buildMetaAssessmentPrompt).toBeDefined();
    expect(buildTaskProfilePrompt).toBeDefined();
  });
});
