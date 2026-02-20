import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolSandbox,
  InMemoryGeneratedToolStore,
  ObservationCollector,
  StrategySelector,
  EvolutionStrategy,
  ModificationValidator,
  RollbackManager,
  InMemoryCheckpointStore,
  SelfModifyingEventEmitter,
  DEFAULT_MODE_PROFILES,
} from '@cogitator-ai/self-modifying';
import type {
  GeneratedTool,
  EvolutionCandidate,
  ModificationRequest,
  TaskProfile,
  SelfModifyingEvent,
  ReasoningMode,
  Insight,
} from '@cogitator-ai/types';

function createGeneratedTool(overrides: Partial<GeneratedTool> = {}): GeneratedTool {
  return {
    id: 'tool_1',
    name: 'add_numbers',
    description: 'Adds two numbers',
    implementation: `function execute(params) { return params.a + params.b; }`,
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    createdAt: new Date(),
    version: 1,
    status: 'validated',
    ...overrides,
  };
}

function createCandidate(overrides: Partial<EvolutionCandidate> = {}): EvolutionCandidate {
  return {
    id: 'candidate_1',
    config: { temperature: 0.5 },
    expectedImprovement: 0.1,
    risk: 'low',
    generation: 1,
    score: 0.5,
    evaluationCount: 0,
    ...overrides,
  };
}

describe('ToolSandbox', () => {
  let sandbox: ToolSandbox;

  beforeEach(() => {
    sandbox = new ToolSandbox({
      enabled: true,
      maxExecutionTime: 3000,
      isolationLevel: 'moderate',
    });
  });

  it('executes valid tool code safely', async () => {
    const tool = createGeneratedTool();
    const result = await sandbox.execute(tool, { a: 3, b: 7 });

    expect(result.success).toBe(true);
    expect(result.result).toBe(10);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  it('handles tool execution timeout', async () => {
    const shortTimeoutSandbox = new ToolSandbox({
      enabled: true,
      maxExecutionTime: 100,
      isolationLevel: 'moderate',
    });

    const tool = createGeneratedTool({
      implementation: `
        async function execute(params) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          return params;
        }
      `,
    });

    const result = await shortTimeoutSandbox.execute(tool, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('testWithCases runs test suite against tool', async () => {
    const tool = createGeneratedTool();

    const testResult = await sandbox.testWithCases(tool, [
      { input: { a: 1, b: 2 }, expectedOutput: 3 },
      { input: { a: -5, b: 5 }, expectedOutput: 0 },
      { input: { a: 100, b: 200 }, expectedOutput: 300 },
    ]);

    expect(testResult.passed).toBe(3);
    expect(testResult.failed).toBe(0);
    expect(testResult.results).toHaveLength(3);
    expect(testResult.results.every((r) => r.passed)).toBe(true);
  });
});

describe('InMemoryGeneratedToolStore', () => {
  let store: InMemoryGeneratedToolStore;

  beforeEach(() => {
    store = new InMemoryGeneratedToolStore();
  });

  it('saves and retrieves tools', async () => {
    const tool = createGeneratedTool();
    await store.save(tool);

    const retrieved = await store.get('tool_1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('add_numbers');
    expect(retrieved!.id).toBe('tool_1');
  });

  it('lists tools with filter', async () => {
    await store.save(createGeneratedTool({ id: 't1', name: 'tool_a', status: 'active' }));
    await store.save(createGeneratedTool({ id: 't2', name: 'tool_b', status: 'active' }));
    await store.save(createGeneratedTool({ id: 't3', name: 'tool_c', status: 'deprecated' }));
    await store.save(createGeneratedTool({ id: 't4', name: 'tool_d', status: 'validated' }));

    const active = await store.list({ status: 'active' });
    expect(active).toHaveLength(2);

    const deprecated = await store.list({ status: 'deprecated' });
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0].name).toBe('tool_c');
  });

  it('records usage and returns metrics', async () => {
    const tool = createGeneratedTool({ id: 'metrics_tool' });
    await store.save(tool);

    await store.recordUsage({
      toolId: 'metrics_tool',
      timestamp: new Date(),
      success: true,
      executionTime: 50,
    });
    await store.recordUsage({
      toolId: 'metrics_tool',
      timestamp: new Date(),
      success: true,
      executionTime: 30,
    });
    await store.recordUsage({
      toolId: 'metrics_tool',
      timestamp: new Date(),
      success: false,
      executionTime: 100,
      error: 'timeout',
    });

    const metrics = await store.getMetrics('metrics_tool');
    expect(metrics).not.toBeNull();
    expect(metrics!.totalUsage).toBe(3);
    expect(metrics!.successCount).toBe(2);
    expect(metrics!.failureCount).toBe(1);
    expect(metrics!.averageExecutionTime).toBe(60);
    expect(metrics!.successRate).toBeCloseTo(2 / 3);
  });
});

describe('ObservationCollector', () => {
  it('collects and retrieves observations', () => {
    const collector = new ObservationCollector();
    const runId = 'run_obs_1';
    collector.initializeRun(runId);

    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'search',
      timestamp: Date.now(),
    });
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'compute',
      timestamp: Date.now(),
    });
    collector.recordConfidence(runId, 0.7);
    collector.recordConfidence(runId, 0.8);

    const insight: Insight = {
      id: 'ins_1',
      type: 'pattern',
      content: 'test insight',
      context: 'test',
      confidence: 0.9,
      usageCount: 0,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      agentId: 'agent_1',
      source: { runId, reflectionId: 'ref_1' },
    };

    const observation = collector.collect(
      {
        runId,
        iteration: 1,
        goal: 'test goal',
        currentMode: 'analytical',
        tokensUsed: 500,
        timeElapsed: 1000,
        iterationsRemaining: 5,
        budgetRemaining: 0.8,
      },
      [insight]
    );

    expect(observation.runId).toBe(runId);
    expect(observation.iteration).toBe(1);
    expect(observation.progressScore).toBeGreaterThanOrEqual(0);
    expect(observation.currentConfidence).toBe(0.8);
    expect(observation.currentMode).toBe('analytical');
    expect(observation.tokensUsed).toBe(500);

    const all = collector.getObservations(runId);
    expect(all).toHaveLength(1);
  });
});

describe('StrategySelector', () => {
  let selector: StrategySelector;
  const allModes: ReasoningMode[] = [
    'analytical',
    'creative',
    'systematic',
    'intuitive',
    'reflective',
    'exploratory',
  ];

  beforeEach(() => {
    selector = new StrategySelector({
      allowedModes: allModes,
      modeProfiles: DEFAULT_MODE_PROFILES,
    });
  });

  it('selects reasoning mode for task profile', () => {
    const profile: TaskProfile = {
      complexity: 'complex',
      domain: 'reasoning',
      estimatedTokens: 5000,
      requiresTools: true,
      requiresReasoning: true,
      requiresCreativity: false,
      toolIntensity: 'moderate',
      reasoningDepth: 'deep',
      creativityLevel: 'low',
      accuracyRequirement: 'high',
      timeConstraint: 'none',
    };

    const mode = selector.selectForTask(profile);
    expect(allModes).toContain(mode);
  });

  it('records outcomes and updates success rates', () => {
    const initialRate = selector.getSuccessRate('analytical');
    expect(initialRate).toBe(0.5);

    selector.recordModeOutcome('run_1', 'analytical', true);
    selector.recordModeOutcome('run_1', 'analytical', true);
    selector.recordModeOutcome('run_2', 'analytical', false);

    const updatedRate = selector.getSuccessRate('analytical');
    expect(updatedRate).toBeCloseTo(2 / 3);
  });
});

describe('EvolutionStrategy', () => {
  it('epsilon-greedy selects from candidates', () => {
    const strategy = new EvolutionStrategy({
      strategy: { type: 'epsilon_greedy', epsilon: 0 },
    });

    const candidates = [
      createCandidate({ id: 'c1', score: 0.3, evaluationCount: 5 }),
      createCandidate({ id: 'c2', score: 0.9, evaluationCount: 5 }),
      createCandidate({ id: 'c3', score: 0.5, evaluationCount: 5 }),
    ];

    const result = strategy.select(candidates);
    expect(result.candidate.id).toBe('c2');
    expect(result.isExploration).toBe(false);
  });

  it('UCB favors unexplored candidates', () => {
    const strategy = new EvolutionStrategy({
      strategy: { type: 'ucb', explorationConstant: 2 },
    });

    const candidates = [
      createCandidate({ id: 'explored', score: 0.9, evaluationCount: 100 }),
      createCandidate({ id: 'unexplored', score: 0, evaluationCount: 0 }),
    ];

    const result = strategy.select(candidates);
    expect(result.candidate.id).toBe('unexplored');
    expect(result.isExploration).toBe(true);
  });
});

describe('ModificationValidator', () => {
  it('validates modifications against constraints', async () => {
    const validator = new ModificationValidator();

    for (const id of ['no_arbitrary_code', 'max_tool_complexity', 'no_self_modification_loop']) {
      validator.removeConstraint(id);
    }
    for (const id of ['allowed_tool_categories']) {
      validator.removeConstraint(id);
    }
    for (const id of ['default_resource_limits']) {
      validator.removeConstraint(id);
    }

    validator.addCapabilityConstraint({
      id: 'test_cap',
      type: 'tool_category',
      description: 'Only math and text allowed',
      allowed: ['math', 'text'],
      forbidden: ['system'],
    });

    const allowedRequest: ModificationRequest = {
      type: 'tool_generation',
      target: 'tool_gen',
      changes: {},
      reason: 'need math tool',
      payload: { category: 'math', complexity: 10 },
    };
    const allowedResult = await validator.validate(allowedRequest);
    expect(allowedResult.valid).toBe(true);
    expect(allowedResult.errors!.length).toBe(0);

    const forbiddenRequest: ModificationRequest = {
      type: 'tool_generation',
      target: 'tool_gen',
      changes: {},
      reason: 'need system tool',
      payload: { category: 'system' },
    };
    const forbiddenResult = await validator.validate(forbiddenRequest);
    expect(forbiddenResult.valid).toBe(false);
    expect(forbiddenResult.errors!.length).toBeGreaterThan(0);
  });
});

describe('RollbackManager', () => {
  let manager: RollbackManager;

  beforeEach(() => {
    manager = new RollbackManager({
      maxCheckpoints: 10,
      checkpointStore: new InMemoryCheckpointStore(),
    });
  });

  it('creates and retrieves checkpoints', async () => {
    const checkpoint = await manager.createCheckpoint(
      'agent_1',
      { name: 'test', model: 'gpt-4', instructions: 'be helpful' },
      [],
      []
    );

    expect(checkpoint.id).toMatch(/^ckpt_/);
    expect(checkpoint.agentId).toBe('agent_1');

    const retrieved = await manager.getCheckpoint(checkpoint.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(checkpoint.id);
  });

  it('rollback restores previous state', async () => {
    const config = { name: 'agent', model: 'gpt-4', instructions: 'original', temperature: 0.5 };
    const tools = [
      { name: 'tool_a', description: 'Tool A', parameters: {}, execute: async () => 'a' },
    ];

    const checkpoint = await manager.createCheckpoint('agent_1', config, tools, []);
    const restored = await manager.rollbackTo(checkpoint.id);

    expect(restored).not.toBeNull();
    expect(restored!.agentConfig).toMatchObject({ name: 'agent', model: 'gpt-4' });
    expect(restored!.tools).toHaveLength(1);
  });

  it('compares checkpoints and shows diff', async () => {
    const cpA = await manager.createCheckpoint(
      'agent_1',
      { name: 'agent', model: 'gpt-4', instructions: 'v1' },
      [{ name: 'old_tool', description: 'Old', parameters: {}, execute: async () => 'old' }],
      []
    );

    const cpB = await manager.createCheckpoint(
      'agent_1',
      { name: 'agent', model: 'gpt-4o', instructions: 'v2' },
      [{ name: 'new_tool', description: 'New', parameters: {}, execute: async () => 'new' }],
      [{ id: 'mod_1', type: 'config_change', appliedAt: new Date(), data: {} }]
    );

    const diff = manager.compareCheckpoints(cpA, cpB);

    expect(diff.configChanges.length).toBeGreaterThan(0);
    const modelChange = diff.configChanges.find((c) => c.key === 'model');
    expect(modelChange).toBeDefined();
    expect(modelChange!.before).toBe('gpt-4');
    expect(modelChange!.after).toBe('gpt-4o');

    expect(diff.toolsAdded).toContain('new_tool');
    expect(diff.toolsRemoved).toContain('old_tool');
    expect(diff.modificationsApplied).toHaveLength(1);
  });
});

describe('SelfModifyingEventEmitter', () => {
  let emitter: SelfModifyingEventEmitter;

  beforeEach(() => {
    emitter = new SelfModifyingEventEmitter();
  });

  it('emits and receives events', async () => {
    const received: SelfModifyingEvent[] = [];
    emitter.on('tool_generation_completed', (event) => {
      received.push(event);
    });

    const event = emitter.createEvent('tool_generation_completed', 'run_1', 'agent_1', {
      toolName: 'calculator',
    });
    await emitter.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('tool_generation_completed');
    expect(received[0].runId).toBe('run_1');
    expect((received[0].data as Record<string, unknown>).toolName).toBe('calculator');
  });

  it('wildcard handler receives all events', async () => {
    const received: SelfModifyingEvent[] = [];
    emitter.on('*', (event) => {
      received.push(event);
    });

    await emitter.emit(emitter.createEvent('run_started', 'r1', 'a1', {}));
    await emitter.emit(emitter.createEvent('tool_generation_started', 'r1', 'a1', {}));
    await emitter.emit(emitter.createEvent('checkpoint_created', 'r1', 'a1', {}));

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe('run_started');
    expect(received[1].type).toBe('tool_generation_started');
    expect(received[2].type).toBe('checkpoint_created');
  });
});
