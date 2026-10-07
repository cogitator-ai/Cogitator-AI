import { describe, it, expect } from 'vitest';
import * as selfModifying from '../index';

/**
 * The package is imported once, while the file is collected: a cold import of
 * every module behind the entry point is slow on a busy CI runner, and inside
 * a test it ran into the per-test timeout.
 */
describe('@cogitator-ai/self-modifying', () => {
  it.each([
    ['the agent', ['SelfModifyingAgent']],
    [
      'tool generation components',
      [
        'GapAnalyzer',
        'ToolGenerator',
        'ToolValidator',
        'ToolSandbox',
        'InMemoryGeneratedToolStore',
      ],
    ],
    ['meta-reasoning components', ['MetaReasoner', 'ObservationCollector', 'StrategySelector']],
    [
      'architecture evolution components',
      ['CapabilityAnalyzer', 'EvolutionStrategy', 'ParameterOptimizer'],
    ],
    [
      'constraints components',
      [
        'ModificationValidator',
        'RollbackManager',
        'InMemoryCheckpointStore',
        'DEFAULT_SAFETY_CONSTRAINTS',
      ],
    ],
    ['events components', ['SelfModifyingEventEmitter']],
    [
      'default configs',
      [
        'DEFAULT_SANDBOX_CONFIG',
        'DEFAULT_META_REASONING_CONFIG',
        'DEFAULT_MODE_PROFILES',
        'DEFAULT_SAFETY_CONSTRAINTS',
        'DEFAULT_CAPABILITY_CONSTRAINTS',
        'DEFAULT_RESOURCE_CONSTRAINTS',
      ],
    ],
    [
      'prompt builders',
      [
        'buildGapAnalysisPrompt',
        'buildToolGenerationPrompt',
        'buildMetaAssessmentPrompt',
        'buildTaskProfilePrompt',
      ],
    ],
  ] as const)('exports %s', (_, names) => {
    for (const name of names) expect(selfModifying[name], name).toBeDefined();
  });
});
