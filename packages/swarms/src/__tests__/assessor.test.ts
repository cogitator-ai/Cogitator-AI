/**
 * Tests for SwarmAssessor and related components
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskAnalyzer } from '../assessor/task-analyzer';
import { ModelScorer, type ScoredModel as _ScoredModel } from '../assessor/scoring';
import { RoleMatcher } from '../assessor/role-matcher';
import { ModelDiscovery } from '../assessor/model-discovery';
import { SwarmAssessor as _SwarmAssessor, createAssessor } from '../assessor/assessor';
import type {
  TaskRequirements,
  RoleRequirements,
  DiscoveredModel,
  SwarmConfig,
  SwarmAgent,
} from '@cogitator-ai/types';

describe('TaskAnalyzer', () => {
  let analyzer: TaskAnalyzer;

  beforeEach(() => {
    analyzer = new TaskAnalyzer();
  });

  describe('analyze', () => {
    it('should detect vision requirements', () => {
      const result = analyzer.analyze('Analyze this screenshot and describe what you see');
      expect(result.needsVision).toBe(true);
    });

    it('should detect tool calling requirements', () => {
      const result = analyzer.analyze('Search the web for the latest news and summarize');
      expect(result.needsToolCalling).toBe(true);
    });

    it('should detect code domain', () => {
      const result = analyzer.analyze('Write a Python function to parse JSON');
      expect(result.domains).toContain('code');
    });

    it('should detect math domain', () => {
      const result = analyzer.analyze('Calculate the derivative of x^2 + 3x');
      expect(result.domains).toContain('math');
    });

    it('should detect creative domain', () => {
      const result = analyzer.analyze('Write a creative story about space exploration');
      expect(result.domains).toContain('creative');
    });

    it('should detect analysis domain', () => {
      const result = analyzer.analyze('Analyze this research paper and summarize key findings');
      expect(result.domains).toContain('analysis');
    });

    it('should detect advanced reasoning for complex tasks', () => {
      const result = analyzer.analyze(
        'Analyze the philosophical implications of AI consciousness and provide a critical evaluation'
      );
      expect(result.needsReasoning).toBe('advanced');
    });

    it('should detect basic reasoning for simple tasks', () => {
      const result = analyzer.analyze('What is 2+2?');
      expect(result.needsReasoning).toBe('basic');
    });

    it('should detect long context requirements', () => {
      const result = analyzer.analyze('Read this entire document and summarize it');
      expect(result.needsLongContext).toBe(true);
    });

    it('should detect fast speed preference', () => {
      const result = analyzer.analyze('Quick! Give me a fast response immediately');
      expect(result.needsSpeed).toBe('fast');
    });
  });
});

describe('ModelScorer', () => {
  let scorer: ModelScorer;

  const createMockModel = (overrides: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
    id: 'test-model',
    provider: 'ollama',
    displayName: 'Test Model',
    capabilities: {
      supportsVision: false,
      supportsTools: false,
      supportsStreaming: true,
      supportsJson: true,
    },
    pricing: { input: 0, output: 0 },
    contextWindow: 8192,
    isLocal: true,
    isAvailable: true,
    ...overrides,
  });

  const createMockRequirements = (overrides: Partial<RoleRequirements> = {}): RoleRequirements => ({
    needsVision: false,
    needsToolCalling: false,
    needsLongContext: false,
    needsReasoning: 'basic',
    needsSpeed: 'balanced',
    costSensitivity: 'medium',
    complexity: 'simple',
    role: 'worker',
    agentName: 'test-agent',
    ...overrides,
  });

  beforeEach(() => {
    scorer = new ModelScorer();
  });

  describe('score', () => {
    it('should give 0 score when vision is required but not supported', () => {
      const model = createMockModel({ capabilities: { supportsVision: false } });
      const reqs = createMockRequirements({ needsVision: true });

      const result = scorer.score(model, reqs);
      expect(result.score).toBe(0);
    });

    it('should give 0 score when tool calling is required but not supported', () => {
      const model = createMockModel({ capabilities: { supportsTools: false } });
      const reqs = createMockRequirements({ needsToolCalling: true });

      const result = scorer.score(model, reqs);
      expect(result.score).toBe(0);
    });

    it('should penalize limited context when long context is required', () => {
      const shortContext = createMockModel({ contextWindow: 4096 });
      const longContext = createMockModel({ contextWindow: 100000 });
      const reqs = createMockRequirements({ needsLongContext: true });

      const shortResult = scorer.score(shortContext, reqs);
      const longResult = scorer.score(longContext, reqs);

      expect(longResult.score).toBeGreaterThan(shortResult.score);
    });

    it('should give bonus points for local models', () => {
      const localModel = createMockModel({ id: 'local', isLocal: true });
      const cloudModel: DiscoveredModel = {
        id: 'cloud',
        provider: 'openai',
        displayName: 'Cloud Model',
        capabilities: { supportsVision: false, supportsTools: false, supportsStreaming: true, supportsJson: true },
        pricing: { input: 0.5, output: 0.5 },
        contextWindow: 8192,
        isLocal: false,
        isAvailable: true,
      };
      const reqs = createMockRequirements();

      const localResult = scorer.score(localModel, reqs);
      const cloudResult = scorer.score(cloudModel, reqs);

      // Local model should have "Local model (no API cost)" in reasons
      expect(localResult.reasons).toContain('Local model (no API cost)');
      expect(cloudResult.reasons).not.toContain('Local model (no API cost)');

      // Local model gets +15 bonus, so should score higher
      expect(localResult.score).toBeGreaterThan(cloudResult.score);
    });

    it('should prefer cheaper models when cost sensitivity is high', () => {
      // Cost sensitivity only applies to cloud models
      const cheapModel = createMockModel({
        id: 'cheap-cloud',
        isLocal: false,
        pricing: { input: 0.5, output: 0.5 }, // avgCost = 0.5 (< 1 = cheap)
      });
      const expensiveModel = createMockModel({
        id: 'expensive-cloud',
        isLocal: false,
        pricing: { input: 15, output: 15 }, // avgCost = 15 (> 10 = expensive)
      });
      const reqs = createMockRequirements({ costSensitivity: 'high' });

      const cheapResult = scorer.score(cheapModel, reqs);
      const expensiveResult = scorer.score(expensiveModel, reqs);

      // Cheap model gets +10 bonus, expensive gets -25 penalty
      expect(cheapResult.score).toBeGreaterThan(expensiveResult.score);
    });
  });

  describe('scoreAll', () => {
    it('should score and sort all models by score descending', () => {
      const models: DiscoveredModel[] = [
        createMockModel({ id: 'model-a', isLocal: false }),
        createMockModel({ id: 'model-b', isLocal: true }),
        createMockModel({ id: 'model-c', isLocal: false }),
      ];
      const reqs = createMockRequirements();

      const results = scorer.scoreAll(models, reqs);

      expect(results).toHaveLength(3);
      // First result should have highest score
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    });

    it('should filter out models with 0 score', () => {
      const models: DiscoveredModel[] = [
        createMockModel({
          id: 'model-a',
          capabilities: { supportsVision: true, supportsTools: false, supportsStreaming: true, supportsJson: true },
        }),
        createMockModel({
          id: 'model-b',
          capabilities: { supportsVision: false, supportsTools: false, supportsStreaming: true, supportsJson: true },
        }),
      ];
      const reqs = createMockRequirements({ needsVision: true });

      const results = scorer.scoreAll(models, reqs);

      expect(results).toHaveLength(1);
      expect(results[0].model.id).toBe('model-a');
    });
  });
});

describe('RoleMatcher', () => {
  let matcher: RoleMatcher;

  const createMockTaskReqs = (overrides: Partial<TaskRequirements> = {}): TaskRequirements => ({
    needsVision: false,
    needsToolCalling: false,
    needsLongContext: false,
    needsReasoning: 'basic',
    needsSpeed: 'balanced',
    costSensitivity: 'medium',
    complexity: 'simple',
    ...overrides,
  });

  const createMockSwarmAgent = (
    name: string,
    role: 'supervisor' | 'worker' | 'moderator' | 'router' | 'critic' | 'advocate',
    expertise: string[] = []
  ): SwarmAgent => ({
    agent: { name } as SwarmAgent['agent'],
    metadata: { role, expertise },
    state: 'idle',
    messageCount: 0,
    tokenCount: 0,
  });

  beforeEach(() => {
    matcher = new RoleMatcher();
  });

  describe('analyzeRole', () => {
    it('should upgrade reasoning for supervisor role', () => {
      const agent = createMockSwarmAgent('supervisor', 'supervisor');
      const taskReqs = createMockTaskReqs({ needsReasoning: 'basic' });

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.needsReasoning).toBe('advanced');
    });

    it('should upgrade reasoning for critic role', () => {
      const agent = createMockSwarmAgent('critic', 'critic');
      const taskReqs = createMockTaskReqs({ needsReasoning: 'basic' });

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.needsReasoning).toBe('moderate');
    });

    it('should detect coding needs from expertise', () => {
      const agent = createMockSwarmAgent('coder', 'worker', ['programming', 'development']);
      const taskReqs = createMockTaskReqs();

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.needsToolCalling).toBe(true);
      expect(result.domains).toContain('code');
    });

    it('should detect vision needs from expertise', () => {
      const agent = createMockSwarmAgent('designer', 'worker', ['image design', 'visual']);
      const taskReqs = createMockTaskReqs();

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.needsVision).toBe(true);
    });

    it('should set fast speed for router role', () => {
      const agent = createMockSwarmAgent('router', 'router');
      const taskReqs = createMockTaskReqs({ needsSpeed: 'slow-ok' });

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.needsSpeed).toBe('fast');
    });

    it('should lower cost sensitivity for supervisor', () => {
      const agent = createMockSwarmAgent('supervisor', 'supervisor');
      const taskReqs = createMockTaskReqs({ costSensitivity: 'high' });

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.costSensitivity).toBe('medium');
    });

    it('should raise cost sensitivity for worker', () => {
      const agent = createMockSwarmAgent('worker1', 'worker');
      const taskReqs = createMockTaskReqs({ costSensitivity: 'medium' });

      const result = matcher.analyzeRole(agent, taskReqs);

      expect(result.costSensitivity).toBe('high');
    });
  });

  describe('extractAgentsFromConfig', () => {
    it('should extract supervisor from config', () => {
      const config = { supervisor: { name: 'boss' } };
      const agents = matcher.extractAgentsFromConfig(config);

      expect(agents).toHaveLength(1);
      expect(agents[0].agent.name).toBe('boss');
      expect(agents[0].metadata.role).toBe('supervisor');
    });

    it('should extract workers from config', () => {
      const config = { workers: [{ name: 'worker1' }, { name: 'worker2' }] };
      const agents = matcher.extractAgentsFromConfig(config);

      expect(agents).toHaveLength(2);
      expect(agents.every((a) => a.metadata.role === 'worker')).toBe(true);
    });

    it('should extract moderator and router', () => {
      const config = {
        moderator: { name: 'mod' },
        router: { name: 'route' },
      };
      const agents = matcher.extractAgentsFromConfig(config);

      expect(agents).toHaveLength(2);
      expect(agents.find((a) => a.agent.name === 'mod')?.metadata.role).toBe('moderator');
      expect(agents.find((a) => a.agent.name === 'route')?.metadata.role).toBe('router');
    });

    it('should extract pipeline stages', () => {
      const config = {
        stages: [{ agent: { name: 'stage1' } }, { agent: { name: 'stage2' } }],
      };
      const agents = matcher.extractAgentsFromConfig(config);

      expect(agents).toHaveLength(2);
    });
  });
});

describe('ModelDiscovery', () => {
  let discovery: ModelDiscovery;

  beforeEach(() => {
    discovery = new ModelDiscovery({
      ollamaUrl: 'http://localhost:11434',
      enabledProviders: ['ollama', 'openai', 'anthropic', 'google'],
    });
  });

  describe('getCloudModels', () => {
    it('should return cloud models', () => {
      const models = discovery.getCloudModels();

      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => !m.isLocal)).toBe(true);
    });

    it('should filter by provider', () => {
      const openaiModels = discovery.getCloudModels(['openai']);

      expect(openaiModels.length).toBeGreaterThan(0);
      expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);
    });
  });
});

describe('SwarmAssessor', () => {
  describe('createAssessor', () => {
    it('should create assessor with default config', () => {
      const assessor = createAssessor({});
      expect(assessor).toBeDefined();
    });

    it('should create assessor with custom config', () => {
      const assessor = createAssessor({
        mode: 'rules',
        preferLocal: true,
        maxCostPerRun: 0.5,
      });
      expect(assessor).toBeDefined();
    });
  });

  describe('assignModels', () => {
    it('should skip locked agents', () => {
      const assessor = createAssessor({});

      const config: SwarmConfig = {
        name: 'test-swarm',
        strategy: 'hierarchical',
        supervisor: {
          name: 'supervisor',
          model: 'gpt-4o',
          metadata: { locked: true },
        } as SwarmConfig['supervisor'],
        workers: [{ name: 'worker1', model: 'gpt-3.5-turbo' }] as SwarmConfig['workers'],
      };

      const result = {
        taskAnalysis: {} as TaskRequirements,
        roleAnalyses: new Map(),
        assignments: [
          {
            agentName: 'supervisor',
            originalModel: 'gpt-4o',
            assignedModel: 'claude-3-opus',
            provider: 'anthropic' as const,
            score: 90,
            reasons: [],
            fallbackModels: [],
            locked: true,
          },
          {
            agentName: 'worker1',
            originalModel: 'gpt-3.5-turbo',
            assignedModel: 'llama3.2',
            provider: 'ollama' as const,
            score: 80,
            reasons: [],
            fallbackModels: [],
            locked: false,
          },
        ],
        totalEstimatedCost: 0.01,
        warnings: [],
        discoveredModels: [],
      };

      const updatedConfig = assessor.assignModels(config, result);

      expect(updatedConfig.supervisor?.model).toBe('gpt-4o');
      expect(updatedConfig.workers?.[0]?.model).toBe('llama3.2');
    });
  });
});
